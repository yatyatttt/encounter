// Pure encounter domain (PRD 5): state in -> new state out. No IO. The server loads an EncounterState,
// calls applyCommand, and writes the whole result back in one transaction.
import { z } from 'zod';
import {
  MAX_COMBATANTS, RULES_VERSION,
  type CombatantDto, type CombatantFields, type ConditionDto, type ConcentrationDto, type DuplicateOptions, type EncounterCommand,
  type EncounterSnapshot, type EncounterStatus, type InitiativeInput, type TimingDto, type BoundaryKind, type EffectDuration,
} from '../shared/contract';
import { AppError } from './errors';
import { applyDamage, applyHealing, grantTempHp, type Hp } from './hp';
import { concentrationDc, isIncapacitated } from './concentration';
import { emptyTiming, endEffect, expiryRound, processBoundary, type Boundary } from './timing';

// ---------- state ----------
const OrderKeys = z.record(z.string(), z.object({ initiative: z.number().int(), tieRank: z.number().int().min(0) }).strict());
export const ScheduleSchema = z.object({ pendingIds: z.array(z.string()), actedIds: z.array(z.string()), orderKeys: OrderKeys }).strict();
export type Schedule = z.infer<typeof ScheduleSchema>;
/** Scheduling state immediately before the most recent Next Turn (powers Previous Turn). */
export const CheckpointSchema = z.object({ round: z.number().int().min(0), activeId: z.string().nullable(), schedule: ScheduleSchema }).strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export type Combatant = Omit<CombatantDto, 'eligible'>;
export type EncounterState = {
  id: string; name: string; notes: string; status: EncounterStatus;
  round: number; activeId: string | null; schedule: Schedule; checkpoint: Checkpoint | null;
  skipZeroHpEnemies: boolean; version: number; rulesVersion: string;
  startedAt: number | null; completedAt: number | null; archivedAt: number | null; createdAt: number; updatedAt: number;
  combatants: Combatant[]; conditions: ConditionDto[]; concentrations: ConcentrationDto[];
  timing: TimingDto;
};

export type Ctx = {
  now: number;
  newId: () => string;
  template: (id: string) => CombatantFields | undefined;
  otherActive: string | null; // name of another active encounter, if any (single-active rule)
};

export const emptySchedule = (): Schedule => ({ pendingIds: [], actedIds: [], orderKeys: {} });

export function newEncounter(name: string, ctx: Pick<Ctx, 'now' | 'newId'>): EncounterState {
  return {
    id: ctx.newId(), name, notes: '', status: 'draft', round: 0, activeId: null, schedule: emptySchedule(), checkpoint: null,
    skipZeroHpEnemies: true, version: 1, rulesVersion: RULES_VERSION,
    startedAt: null, completedAt: null, archivedAt: null, createdAt: ctx.now, updatedAt: ctx.now,
    combatants: [], conditions: [], concentrations: [], timing: emptyTiming(),
  };
}

// ---------- ordering / eligibility ----------
type Key = { id: string; initiative: number; tieRank: number };
const compareKeys = (a: Key, b: Key) => b.initiative - a.initiative || a.tieRank - b.tieRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function isEligible(c: Combatant, skipZeroHpEnemies: boolean): boolean {
  if (c.removedAt !== null || c.initiativeTotal === null) return false;
  if (c.turnPolicy !== 'default') return c.turnPolicy === 'include';
  return !(c.kind === 'enemy' && skipZeroHpEnemies && c.currentHp === 0);
}

function buildOrder(s: EncounterState) {
  const keys: Key[] = s.combatants
    .filter((c) => isEligible(c, s.skipZeroHpEnemies))
    .map((c) => ({ id: c.id, initiative: c.initiativeTotal!, tieRank: c.tieRank }))
    .sort(compareKeys);
  return {
    ids: keys.map((k) => k.id),
    orderKeys: Object.fromEntries(keys.map((k) => [k.id, { initiative: k.initiative, tieRank: k.tieRank }])),
  };
}

function initiativeFields(i: InitiativeInput, modifier: number) {
  return i.mode === 'total'
    ? { initiativeTotal: i.total, initiativeRoll: null, initiativeMode: 'total' as const }
    : { initiativeTotal: i.roll + modifier, initiativeRoll: i.roll, initiativeMode: 'roll' as const };
}

function setInitiative(s: EncounterState, c: Combatant, input: InitiativeInput) {
  const f = initiativeFields(input, c.initiativeModifier);
  const changed = c.initiativeTotal !== f.initiativeTotal;
  Object.assign(c, f);
  if (changed) {
    // next free tie rank within the equal-total group keeps ties stable
    const ranks = s.combatants.filter((o) => o.id !== c.id && o.removedAt === null && o.initiativeTotal === f.initiativeTotal).map((o) => o.tieRank);
    c.tieRank = ranks.length ? Math.max(...ranks) + 1 : 0;
  }
}

/** Next Turn algorithm (PRD 5.4); also used when the active combatant is removed and on Resume. */
function advance(s: EncounterState, boundary: (kind: BoundaryKind, combatantId?: string | null) => void = () => {}) {
  const sch = s.schedule;
  if (s.activeId !== null) {
    if (isEligible(s.combatants.find((c) => c.id === s.activeId)!, s.skipZeroHpEnemies)) boundary('TURN_END', s.activeId);
    sch.actedIds.push(s.activeId);
    s.activeId = null;
  }
  const byId = new Map(s.combatants.map((c) => [c.id, c]));
  sch.pendingIds = sch.pendingIds.filter((id) => {
    const c = byId.get(id);
    return !!c && isEligible(c, s.skipZeroHpEnemies);
  });
  if (sch.pendingIds.length) {
    s.activeId = sch.pendingIds.shift()!;
    boundary('TURN_START', s.activeId);
    return;
  }
  const order = buildOrder(s);
  if (s.round > s.timing.lastRoundEnd) { boundary('ROUND_END'); s.timing.lastRoundEnd = s.round; }
  if (order.ids.length === 0) {
    s.status = 'paused';
    return;
  }
  s.round += 1;
  sch.actedIds = [];
  sch.orderKeys = order.orderKeys;
  s.activeId = order.ids[0];
  sch.pendingIds = order.ids.slice(1);
  boundary('ROUND_START');
  boundary('TURN_START', s.activeId);
}

/** Explicit current-round join: capture a key and insert against the remaining queue's frozen keys. */
function joinCurrentRound(s: EncounterState, c: Combatant) {
  const sch = s.schedule;
  if (!isEligible(c, s.skipZeroHpEnemies) || c.id === s.activeId || sch.actedIds.includes(c.id) || sch.pendingIds.includes(c.id)) return;
  const key = { initiative: c.initiativeTotal!, tieRank: c.tieRank };
  sch.orderKeys[c.id] = key;
  const at = sch.pendingIds.findIndex((id) => compareKeys({ id, ...sch.orderKeys[id] }, { id: c.id, ...key }) > 0);
  sch.pendingIds.splice(at < 0 ? sch.pendingIds.length : at, 0, c.id);
}

// ---------- commands ----------
const fail = (code: ConstructorParameters<typeof AppError>[0], message: string, fieldErrors?: Record<string, string[]>): never => {
  throw new AppError(code, message, { fieldErrors });
};

const REQUIRED_STATUS: Partial<Record<EncounterCommand['type'], EncounterStatus[]>> = {
  START_COMBAT: ['draft'], NEXT_TURN: ['active'], PREVIOUS_TURN: ['active'], PAUSE_COMBAT: ['active'],
  RESUME_COMBAT: ['paused'], COMPLETE_COMBAT: ['active', 'paused'],
};

export function applyCommand(prev: EncounterState, cmd: EncounterCommand, ctx: Ctx): { state: EncounterState; affectedIds: string[] } {
  const s = structuredClone(prev);
  const affected: string[] = [];
  const running = s.status === 'active' || s.status === 'paused';

  if (s.status === 'completed' && cmd.type !== 'UPDATE_METADATA' && cmd.type !== 'ARCHIVE_ENCOUNTER' && cmd.type !== 'UNARCHIVE_ENCOUNTER') {
    fail('INVALID_STATE', 'Completed encounters are read-only (rename, archive or unarchive only)');
  }
  const allowed = REQUIRED_STATUS[cmd.type];
  if (allowed && !allowed.includes(s.status)) fail('INVALID_STATE', `${cmd.type} is not allowed while the encounter is ${s.status}`);

  const get = (id: string) => s.combatants.find((c) => c.id === id) ?? fail('NOT_FOUND', 'Combatant not found');
  const live = (id: string) => {
    const c = get(id);
    return c.removedAt === null ? c : fail('INVALID_STATE', `${c.name} has been removed from this encounter`);
  };
  const setHp = (c: Combatant, hp: Hp) => {
    c.currentHp = hp.hp;
    c.tempHp = hp.tempHp;
    if (s.status === 'draft') { // in a draft, HP edits define the starting values
      c.startingHp = hp.hp;
      c.startingTempHp = hp.tempHp;
    }
  };
  const hpOf = (c: Combatant): Hp => ({ hp: c.currentHp, tempHp: c.tempHp });
  const boundary = (kind: BoundaryKind, combatantId: string | null = null) => {
    const b: Boundary = { id: ++s.timing.boundaryId, kind, round: s.round, combatantId };
    processBoundary(s, b, affected, ctx.newId);
  };
  const validateEffect = (effect: Extract<EncounterCommand, { type: 'CREATE_EFFECT' }>['effect'], existingTargets: string[] = []) => {
    if (effect.sourceCombatantId) get(effect.sourceCombatantId);
    if (new Set(effect.targetCombatantIds).size !== effect.targetCombatantIds.length) fail('VALIDATION', 'Effect targets must be unique');
    // Existing tombstoned targets may be retained for review/reinstatement; new targets must be live.
    effect.targetCombatantIds.forEach((id) => existingTargets.includes(id) ? get(id) : live(id));
    const d = effect.duration;
    if ((d.kind === 'next-turn' || d.kind === 'rounds') && d.anchorCombatantId) get(d.anchorCombatantId);
    if (d.kind === 'concentration') {
      const conc = s.concentrations.find((c) => c.id === d.concentrationId) ?? fail('NOT_FOUND', 'Concentration not found');
      if (effect.sourceCombatantId !== conc.combatantId) fail('VALIDATION', 'A concentration effect must use its caster as source');
    }
  };
  const concentration = (id: string) => s.concentrations.find((c) => c.id === id) ?? fail('NOT_FOUND', 'Concentration not found');
  const releaseConditionTimer = (condition: ConditionDto) => {
    const id = condition.effectId;
    condition.effectId = null;
    const timer = s.timing.effects.find((e) => e.id === id);
    if (!timer) return; // legacy concentration links have no independent timer
    const remaining = s.conditions.filter((c) => c.effectId === id);
    if (!remaining.length) endEffect(s, timer.id, affected);
    else if (!remaining.some((c) => c.targetCombatantId === condition.targetCombatantId)) {
      timer.targetCombatantIds = timer.targetCombatantIds.filter((target) => target !== condition.targetCombatantId);
      for (const o of s.timing.occurrences) if (o.reminderId === null && o.effectId === id && o.targetCombatantId === condition.targetCombatantId && o.status !== 'resolved') { o.status = 'resolved'; o.outcome = 'effect-ended'; }
    }
  };
  const setConditionDuration = (condition: ConditionDto, duration: EffectDuration) => {
    const old = s.timing.effects.find((e) => e.id === condition.effectId);
    const ownTimer = old && old.targetCombatantIds.length === 1 && s.conditions.filter((c) => c.effectId === old.id).length === 1 ? old : undefined;
    if (!ownTimer) releaseConditionTimer(condition); // editing a legacy shared duration must not change other applications
    if (duration.kind === 'concentration') condition.sourceCombatantId = concentration(duration.concentrationId).combatantId;
    const input = { name: `${condition.conditionKey[0].toUpperCase()}${condition.conditionKey.slice(1)} · ${get(condition.targetCombatantId).name}${condition.sourceLabel ? ` · ${condition.sourceLabel}` : ''}`.slice(0, 200), sourceCombatantId: condition.sourceCombatantId, targetCombatantIds: [condition.targetCombatantId], duration };
    validateEffect(input, [condition.targetCombatantId]); // this application may remain on a tombstoned target
    const timing = { createdVersion: s.version + 1, createdBoundaryId: s.timing.boundaryId, armedBoundaryId: null, expiresRound: expiryRound(s, duration) };
    if (ownTimer) {
      Object.assign(ownTimer, input, timing);
      for (const o of s.timing.occurrences) if (o.reminderId === null && o.effectId === ownTimer.id && o.status !== 'resolved') { o.status = 'resolved'; o.outcome = 'effect-ended'; }
    } else {
      if (s.timing.effects.length >= 500) fail('VALIDATION', 'At most 500 timed conditions per encounter');
      const timer = { ...input, ...timing, id: ctx.newId() };
      s.timing.effects.push(timer);
      condition.effectId = timer.id;
    }
  };
  const endConcentration = (id: string) => {
    const c = concentration(id);
    const effectIds = new Set(c.linkedEffects.map((e) => e.id));
    affected.push(c.combatantId, ...s.conditions.filter((k) => k.effectId !== null && effectIds.has(k.effectId)).map((k) => k.targetCombatantId));
    s.conditions = s.conditions.filter((k) => k.effectId === null || !effectIds.has(k.effectId));
    s.concentrations = s.concentrations.filter((k) => k.id !== id);
    for (const effect of [...s.timing.effects]) if (effect.duration.kind === 'concentration' && effect.duration.concentrationId === id) endEffect(s, effect.id, affected);
  };
  const checkpoint: Checkpoint = { round: s.round, activeId: s.activeId, schedule: structuredClone(s.schedule) };
  s.checkpoint = null; // every mutation clears it; only NEXT_TURN sets it again

  switch (cmd.type) {
    case 'UPDATE_METADATA':
      if (cmd.name !== undefined) s.name = cmd.name;
      if (cmd.notes !== undefined) s.notes = cmd.notes;
      if (cmd.skipZeroHpEnemies !== undefined) s.skipZeroHpEnemies = cmd.skipZeroHpEnemies;
      break;

    case 'ADD_COMBATANTS': {
      const count = cmd.entries.reduce((n, e) => n + e.quantity, 0);
      if (s.combatants.filter((c) => c.removedAt === null).length + count > MAX_COMBATANTS) {
        fail('INVALID_STATE', `An encounter can have at most ${MAX_COMBATANTS} combatants`);
      }
      cmd.entries.forEach((e, idx) => {
        const base = e.templateId ? (ctx.template(e.templateId) ?? fail('NOT_FOUND', 'Template not found')) : e.adhoc!;
        if (base.startingHp !== null && base.startingHp > base.maxHp) fail('VALIDATION', 'Starting HP cannot exceed max HP', { [`entries.${idx}.adhoc.startingHp`]: ['Cannot exceed max HP'] });
        if (running && !e.initiative) fail('VALIDATION', 'Initiative is required when adding to a running encounter', { [`entries.${idx}.initiative`]: ['Required'] });
        for (let n = 1; n <= e.quantity; n++) {
          const hp = base.startingHp ?? base.maxHp;
          const c: Combatant = {
            id: ctx.newId(), templateId: e.templateId ?? null, kind: base.kind, name: e.quantity > 1 ? `${e.name ?? base.name} ${n}` : (e.name ?? base.name),
            maxHp: base.maxHp, currentHp: hp, tempHp: base.startingTempHp, startingHp: hp, startingTempHp: base.startingTempHp,
            armorClass: base.armorClass, initiativeModifier: base.initiativeModifier, speedFt: base.speedFt,
            className: base.className, level: base.level, passivePerception: base.passivePerception, notes: base.notes,
            initiativeTotal: null, initiativeRoll: null, initiativeMode: 'total', tieRank: 0,
            turnPolicy: 'default', exhaustionLevel: 0, removedAt: null,
          };
          if (e.initiative) setInitiative(s, c, e.initiative);
          s.combatants.push(c);
          affected.push(c.id);
          if (running && cmd.joinPolicy === 'current-round') joinCurrentRound(s, c);
        }
      });
      break;
    }

    case 'UPDATE_COMBATANT':
      Object.assign(get(cmd.combatantId), cmd.patch);
      affected.push(cmd.combatantId);
      break;

    case 'REMOVE_COMBATANT': {
      const c = live(cmd.combatantId);
      const conc = s.concentrations.find((k) => k.combatantId === c.id);
      if (conc && !cmd.concentrationPolicy) fail('VALIDATION', 'Choose whether to keep or end concentration when removing its caster');
      if (conc && cmd.concentrationPolicy === 'end') endConcentration(conc.id);
      c.removedAt = ctx.now;
      s.schedule.pendingIds = s.schedule.pendingIds.filter((id) => id !== c.id);
      if (s.activeId === c.id) {
        if (s.status === 'active') advance(s, boundary); // removed creatures do not emit normal turn boundaries
        else {
          s.schedule.actedIds.push(c.id); // paused: no progression, resume selects
          s.activeId = null;
        }
      }
      affected.push(c.id);
      break;
    }

    case 'REINSTATE_COMBATANT': {
      const c = get(cmd.combatantId);
      if (c.removedAt === null) fail('INVALID_STATE', `${c.name} is not removed`);
      c.removedAt = null;
      if (running && cmd.joinPolicy === 'current-round') joinCurrentRound(s, c); // no-op if it already acted
      affected.push(c.id);
      break;
    }

    case 'SET_TURN_POLICY':
      live(cmd.combatantId).turnPolicy = cmd.policy;
      affected.push(cmd.combatantId);
      break;

    case 'SET_INITIATIVE':
      // Takes effect immediately in a draft; while running only the combatant's value changes (the frozen schedule is untouched).
      for (const e of cmd.entries) {
        setInitiative(s, live(e.combatantId), e);
        affected.push(e.combatantId);
      }
      break;

    case 'SET_TIE_ORDER': {
      const group = cmd.combatantIds.map(live);
      const total = group[0].initiativeTotal;
      const members = s.combatants.filter((c) => c.removedAt === null && total !== null && c.initiativeTotal === total);
      if (total === null || new Set(cmd.combatantIds).size !== group.length || group.some((c) => c.initiativeTotal !== total) || members.length !== group.length) {
        fail('VALIDATION', 'Tie order must list every combatant of exactly one equal-initiative group, once each', { combatantIds: ['Must be exactly one tie group'] });
      }
      group.forEach((c, rank) => { c.tieRank = rank; });
      affected.push(...cmd.combatantIds);
      break;
    }

    case 'APPLY_DAMAGE': {
      const c = live(cmd.combatantId);
      const conc = s.concentrations.find((k) => k.combatantId === c.id);
      if (conc && cmd.amount > 0) conc.checks.push({ id: ctx.newId(), damage: cmd.amount, dc: concentrationDc(cmd.amount), createdVersion: s.version + 1 });
      setHp(c, applyDamage(hpOf(c), cmd.amount));
      affected.push(c.id);
      break;
    }
    case 'APPLY_HEALING': {
      const c = live(cmd.combatantId);
      setHp(c, applyHealing(hpOf(c), c.maxHp, cmd.amount));
      affected.push(c.id);
      break;
    }
    case 'SET_HP': {
      const c = live(cmd.combatantId);
      if (cmd.value > c.maxHp) fail('VALIDATION', `HP must be between 0 and ${c.maxHp}`, { value: [`Must be between 0 and ${c.maxHp}`] });
      setHp(c, { hp: cmd.value, tempHp: c.tempHp });
      affected.push(c.id);
      break;
    }
    case 'SET_MAX_HP': {
      const c = live(cmd.combatantId);
      c.maxHp = cmd.value;
      c.currentHp = Math.min(c.currentHp, c.maxHp);
      c.startingHp = Math.min(c.startingHp, c.maxHp);
      affected.push(c.id);
      break;
    }
    case 'GRANT_TEMP_HP': {
      const c = live(cmd.combatantId);
      setHp(c, grantTempHp(hpOf(c), cmd.amount, cmd.choice));
      affected.push(c.id);
      break;
    }
    case 'SET_TEMP_HP': {
      const c = live(cmd.combatantId);
      setHp(c, { hp: c.currentHp, tempHp: cmd.value });
      affected.push(c.id);
      break;
    }

    case 'ADD_CONDITION': {
      live(cmd.combatantId);
      if (cmd.duration && cmd.effectId) fail('VALIDATION', 'Choose a condition duration or a legacy link, not both');
      if (cmd.sourceCombatantId) get(cmd.sourceCombatantId);
      const owner = cmd.effectId ? s.concentrations.find((k) => k.linkedEffects.some((e) => e.id === cmd.effectId)) : undefined;
      const effect = s.timing.effects.find((e) => e.id === cmd.effectId);
      if (cmd.effectId && !owner && !effect) fail('NOT_FOUND', 'Linked effect not found');
      if (effect && !effect.targetCombatantIds.includes(cmd.combatantId)) fail('VALIDATION', 'Combatant is not a target of this effect');
      const condition: ConditionDto = {
        id: ctx.newId(), targetCombatantId: cmd.combatantId, conditionKey: cmd.conditionKey,
        sourceCombatantId: effect ? effect.sourceCombatantId : owner?.combatantId ?? cmd.sourceCombatantId ?? null, sourceLabel: cmd.sourceLabel, notes: cmd.notes, effectId: cmd.effectId ?? null,
      };
      s.conditions.push(condition);
      if (cmd.duration) setConditionDuration(condition, cmd.duration);
      affected.push(cmd.combatantId);
      break;
    }
    case 'UPDATE_CONDITION': {
      const condition = s.conditions.find((c) => c.id === cmd.applicationId) ?? fail('NOT_FOUND', 'Condition application not found');
      get(condition.targetCombatantId);
      if (cmd.sourceCombatantId) get(cmd.sourceCombatantId);
      Object.assign(condition, { sourceCombatantId: cmd.sourceCombatantId, sourceLabel: cmd.sourceLabel, notes: cmd.notes });
      setConditionDuration(condition, cmd.duration);
      affected.push(condition.targetCombatantId);
      break;
    }
    case 'START_CONCENTRATION': {
      const c = live(cmd.combatantId);
      if (isIncapacitated(s.conditions, c.id)) fail('INVALID_STATE', `${c.name} is effectively Incapacitated and cannot concentrate`);
      const old = s.concentrations.find((k) => k.combatantId === c.id);
      if (old && !cmd.replace) fail('INVALID_STATE', `Confirm replacement of ${old.name} and its linked effects`);
      if (!old && s.concentrations.length >= MAX_COMBATANTS) fail('INVALID_STATE', `An encounter can have at most ${MAX_COMBATANTS} active concentrations, including removed casters`);
      if (old) endConcentration(old.id);
      s.concentrations.push({
        id: ctx.newId(), combatantId: c.id, name: cmd.name, startedAt: ctx.now,
        startBoundary: { version: s.version + 1, round: s.round, activeCombatantId: s.activeId },
        linkedEffects: [{ id: ctx.newId(), name: cmd.name }], checks: [],
      });
      affected.push(c.id);
      break;
    }
    case 'END_CONCENTRATION':
      endConcentration(cmd.concentrationId); // manual end and confirmed death have the same bookkeeping
      break;
    case 'CREATE_EFFECT':
      validateEffect(cmd.effect);
      if (s.timing.effects.length >= 500) fail('VALIDATION', 'At most 500 active effects per encounter');
      s.timing.effects.push({ ...cmd.effect, id: ctx.newId(), createdVersion: s.version + 1, createdBoundaryId: s.timing.boundaryId, armedBoundaryId: null, expiresRound: expiryRound(s, cmd.effect.duration) });
      affected.push(...cmd.effect.targetCombatantIds);
      break;
    case 'UPDATE_EFFECT': {
      const effect = s.timing.effects.find((e) => e.id === cmd.effectId) ?? fail('NOT_FOUND', 'Effect not found');
      validateEffect(cmd.effect, effect.targetCombatantIds);
      s.conditions = s.conditions.filter((c) => c.effectId !== effect.id || cmd.effect.targetCombatantIds.includes(c.targetCombatantId));
      for (const c of s.conditions) if (c.effectId === effect.id) c.sourceCombatantId = cmd.effect.sourceCombatantId;
      affected.push(...effect.targetCombatantIds, ...cmd.effect.targetCombatantIds);
      Object.assign(effect, cmd.effect, { createdVersion: s.version + 1, createdBoundaryId: s.timing.boundaryId, armedBoundaryId: null, expiresRound: expiryRound(s, cmd.effect.duration) });
      for (const o of s.timing.occurrences) if (o.reminderId === null && o.effectId === effect.id && o.status !== 'resolved') { o.status = 'resolved'; o.outcome = 'effect-ended'; }
      break;
    }
    case 'END_EFFECT':
      if (!s.timing.effects.some((e) => e.id === cmd.effectId)) fail('NOT_FOUND', 'Effect not found');
      endEffect(s, cmd.effectId, affected);
      break;
    case 'CREATE_REMINDER': {
      const r = cmd.reminder;
      if (r.trigger.kind === 'turn') get(r.trigger.anchorCombatantId);
      if (r.effectId && !s.timing.effects.some((e) => e.id === r.effectId)) fail('NOT_FOUND', 'Reminder effect not found');
      if (s.timing.reminders.length >= 500) fail('VALIDATION', 'At most 500 reminder definitions per encounter');
      s.timing.reminders.push({ ...r, id: ctx.newId(), createdVersion: s.version + 1, createdBoundaryId: s.timing.boundaryId, enabled: true });
      break;
    }
    case 'DISABLE_REMINDER': {
      const r = s.timing.reminders.find((r) => r.id === cmd.reminderId) ?? fail('NOT_FOUND', 'Reminder not found');
      r.enabled = false;
      for (const o of s.timing.occurrences) if (o.reminderId === r.id && o.status !== 'resolved') { o.status = 'resolved'; o.outcome = 'disabled'; }
      break;
    }
    case 'ACKNOWLEDGE_REMINDER':
    case 'RESOLVE_REMINDER': {
      const o = s.timing.occurrences.find((o) => o.id === cmd.occurrenceId) ?? fail('NOT_FOUND', 'Reminder occurrence not found');
      if (o.status === 'resolved') fail('INVALID_STATE', 'Reminder already resolved');
      if (cmd.type === 'ACKNOWLEDGE_REMINDER') { o.status = 'acknowledged'; break; }
      if (o.reminderId === null && cmd.outcome === 'done') fail('VALIDATION', 'Record success or failure for a save-ends effect');
      o.status = 'resolved';
      o.outcome = cmd.outcome;
      if (o.reminderId === null && o.effectId && cmd.outcome === 'success') {
        const e = s.timing.effects.find((e) => e.id === o.effectId) ?? fail('NOT_FOUND', 'Effect not found');
        e.targetCombatantIds = e.targetCombatantIds.filter((id) => id !== o.targetCombatantId);
        s.conditions = s.conditions.filter((c) => c.effectId !== e.id || c.targetCombatantId !== o.targetCombatantId);
        affected.push(o.targetCombatantId!);
        for (const other of s.timing.occurrences) if (other.effectId === e.id && other.targetCombatantId === o.targetCombatantId && other.reminderId === null && other.status !== 'resolved') { other.status = 'resolved'; other.outcome = 'effect-ended'; }
        if (!e.targetCombatantIds.length) endEffect(s, e.id, affected);
      }
      break;
    }
    case 'ADD_CONCENTRATION_EFFECT': {
      const conc = concentration(cmd.concentrationId);
      if (conc.linkedEffects.length >= 200) fail('VALIDATION', 'A concentration can have at most 200 linked effects');
      conc.linkedEffects.push({ id: ctx.newId(), name: cmd.name });
      affected.push(conc.combatantId);
      break;
    }
    case 'RESOLVE_CONCENTRATION_CHECK': {
      const conc = concentration(cmd.concentrationId);
      if (!conc.checks.some((c) => c.id === cmd.checkId)) fail('NOT_FOUND', 'Concentration check not found');
      if (cmd.outcome === 'failure') endConcentration(conc.id);
      else conc.checks = conc.checks.filter((c) => c.id !== cmd.checkId);
      affected.push(conc.combatantId);
      break;
    }
    case 'REMOVE_CONDITION': {
      const cond = s.conditions.find((c) => c.id === cmd.applicationId) ?? fail('NOT_FOUND', 'Condition application not found');
      releaseConditionTimer(cond);
      s.conditions = s.conditions.filter((c) => c !== cond);
      affected.push(cond.targetCombatantId);
      break;
    }
    case 'REMOVE_ALL_CONDITION_SOURCES':
      get(cmd.combatantId);
      for (const c of s.conditions.filter((c) => c.targetCombatantId === cmd.combatantId && c.conditionKey === cmd.conditionKey)) releaseConditionTimer(c);
      s.conditions = s.conditions.filter((c) => !(c.targetCombatantId === cmd.combatantId && c.conditionKey === cmd.conditionKey));
      affected.push(cmd.combatantId);
      break;
    case 'SET_EXHAUSTION':
      live(cmd.combatantId).exhaustionLevel = cmd.level;
      affected.push(cmd.combatantId);
      break;

    case 'START_COMBAT': {
      if (ctx.otherActive) fail('INVALID_STATE', `"${ctx.otherActive}" is already active. Pause it before starting another encounter.`);
      const missing = s.combatants.filter((c) => c.removedAt === null && c.turnPolicy !== 'exclude' && c.initiativeTotal === null);
      if (missing.length) fail('INVALID_STATE', `Set initiative (or exclude from turns) for: ${missing.map((c) => c.name).join(', ')}`);
      const order = buildOrder(s);
      if (order.ids.length === 0) fail('INVALID_STATE', 'No eligible combatants to start combat');
      s.status = 'active';
      s.round = 1;
      s.startedAt = ctx.now;
      s.activeId = order.ids[0];
      s.schedule = { pendingIds: order.ids.slice(1), actedIds: [], orderKeys: order.orderKeys };
      boundary('ROUND_START');
      boundary('TURN_START', s.activeId);
      break;
    }

    case 'NEXT_TURN':
      if (s.activeId) affected.push(s.activeId);
      advance(s, boundary);
      if (s.activeId) {
        affected.push(s.activeId);
        s.checkpoint = checkpoint;
      }
      break;

    case 'PREVIOUS_TURN': {
      const cp = prev.checkpoint ?? fail('INVALID_STATE', 'Previous Turn is only available immediately after Next Turn');
      s.round = cp.round;
      s.activeId = cp.activeId;
      s.schedule = structuredClone(cp.schedule);
      break;
    }

    case 'PAUSE_COMBAT':
      s.status = 'paused';
      break;

    case 'RESUME_COMBAT':
      if (ctx.otherActive) fail('INVALID_STATE', `"${ctx.otherActive}" is already active. Pause it before resuming this encounter.`);
      s.status = 'active';
      if (s.activeId === null) advance(s, boundary); // the paused active combatant was removed: select the next eligible one
      if (s.activeId === null) fail('INVALID_STATE', 'No eligible combatants. Add or reinstate a combatant, or change turn settings, then resume.');
      break;

    case 'COMPLETE_COMBAT':
      boundary('ENCOUNTER_END');
      s.status = 'completed';
      s.completedAt = ctx.now;
      s.activeId = null;
      s.schedule = emptySchedule();
      break;

    case 'UNARCHIVE_ENCOUNTER':
      s.archivedAt = null;
      break;

    case 'ARCHIVE_ENCOUNTER':
      if (s.status === 'active') fail('INVALID_STATE', 'Pause or complete the encounter before archiving it');
      s.archivedAt ??= ctx.now;
      break;
  }

  // Evaluate all sources before cleanup so simultaneous incapacitation is not order-dependent.
  const incapacitated = s.concentrations.filter((c) => isIncapacitated(s.conditions, c.combatantId)).map((c) => c.id);
  for (const id of incapacitated) endConcentration(id);
  if (cmd.type === 'NEXT_TURN' && (prev.timing.effects.some((e) => !s.timing.effects.some((f) => f.id === e.id)) || prev.timing.occurrences.length !== s.timing.occurrences.length)) s.checkpoint = null;
  s.version += 1;
  s.updatedAt = ctx.now;
  return { state: s, affectedIds: [...new Set(affected)] };
}

// ---------- snapshot / duplicate ----------
export function toSnapshot(s: EncounterState): EncounterSnapshot {
  const nextTurnConsequences: string[] = [];
  if (s.status === 'active') {
    const preview = structuredClone(s);
    advance(preview, (kind, combatantId = null) => processBoundary(preview, { id: ++preview.timing.boundaryId, kind, round: preview.round, combatantId }, [], () => `preview-${preview.timing.occurrences.length}`));
    nextTurnConsequences.push(...s.timing.effects.filter((e) => !preview.timing.effects.some((p) => p.id === e.id)).map((e) => `Ends ${e.name}`));
    nextTurnConsequences.push(...preview.timing.occurrences.slice(s.timing.occurrences.length).filter((o) => o.status === 'pending').map((o) => `Reminder: ${o.name}`));
  }
  const combatants = s.combatants
    .map((c): CombatantDto => ({ ...c, eligible: isEligible(c, s.skipZeroHpEnemies) }))
    .sort((a, b) =>
      (a.initiativeTotal === null ? 1 : 0) - (b.initiativeTotal === null ? 1 : 0) ||
      (b.initiativeTotal ?? 0) - (a.initiativeTotal ?? 0) || a.tieRank - b.tieRank || (a.id < b.id ? -1 : 1));
  return {
    id: s.id, name: s.name, notes: s.notes, status: s.status, round: s.round, activeCombatantId: s.activeId,
    schedule: s.schedule, canPreviousTurn: s.checkpoint !== null, skipZeroHpEnemies: s.skipZeroHpEnemies,
    version: s.version, rulesVersion: s.rulesVersion, combatants, conditions: s.conditions, concentrations: s.concentrations, timing: s.timing, nextTurnConsequences,
    startedAt: s.startedAt, completedAt: s.completedAt, archivedAt: s.archivedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/** New draft from an existing encounter: fresh ids, round 0, initiative cleared; the original is untouched. */
export function duplicateEncounter(src: EncounterState, opts: DuplicateOptions, ctx: Pick<Ctx, 'now' | 'newId'>): EncounterState {
  const copy = newEncounter(opts.name ?? `${src.name} (copy)`, ctx);
  copy.notes = src.notes;
  copy.skipZeroHpEnemies = src.skipZeroHpEnemies;
  const ids = new Map<string, string>();
  for (const c of src.combatants.filter((c) => c.removedAt === null)) {
    ids.set(c.id, ctx.newId());
    const hp = opts.hpSource === 'current' ? { hp: c.currentHp, tempHp: c.tempHp } : { hp: c.startingHp, tempHp: c.startingTempHp };
    copy.combatants.push({
      ...c, id: ids.get(c.id)!, currentHp: hp.hp, tempHp: hp.tempHp, startingHp: hp.hp, startingTempHp: hp.tempHp,
      initiativeTotal: null, initiativeRoll: null, initiativeMode: 'total', tieRank: 0,
      exhaustionLevel: opts.copyConditions ? c.exhaustionLevel : 0,
    });
  }
  if (opts.copyConditions) {
    for (const k of src.conditions) {
      const target = ids.get(k.targetCombatantId);
      if (target) copy.conditions.push({ ...k, id: ctx.newId(), targetCombatantId: target, sourceCombatantId: (k.sourceCombatantId && ids.get(k.sourceCombatantId)) || null, effectId: null });
    }
  }
  return copy;
}
