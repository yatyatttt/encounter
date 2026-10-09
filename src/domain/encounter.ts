// Pure encounter domain (PRD 5): state in -> new state out. No IO. The server loads an EncounterState,
// calls applyCommand, and writes the whole result back in one transaction.
import { z } from 'zod';
import {
  MAX_COMBATANTS, RULES_VERSION,
  type CombatantDto, type CombatantFields, type ConditionDto, type DuplicateOptions, type EncounterCommand,
  type EncounterSnapshot, type EncounterStatus, type InitiativeInput,
} from '../shared/contract';
import { AppError } from './errors';
import { applyDamage, applyHealing, grantTempHp, type Hp } from './hp';

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
  combatants: Combatant[]; conditions: ConditionDto[];
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
    combatants: [], conditions: [],
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
function advance(s: EncounterState) {
  const sch = s.schedule;
  if (s.activeId !== null) {
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
    return;
  }
  const order = buildOrder(s);
  if (order.ids.length === 0) {
    s.status = 'paused';
    return;
  }
  s.round += 1;
  sch.actedIds = [];
  sch.orderKeys = order.orderKeys;
  s.activeId = order.ids[0];
  sch.pendingIds = order.ids.slice(1);
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

  if (s.status === 'completed' && cmd.type !== 'UPDATE_METADATA' && cmd.type !== 'ARCHIVE_ENCOUNTER') {
    fail('INVALID_STATE', 'Completed encounters are read-only (rename or archive only)');
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
      c.removedAt = ctx.now;
      s.schedule.pendingIds = s.schedule.pendingIds.filter((id) => id !== c.id);
      if (s.activeId === c.id) {
        if (s.status === 'active') advance(s); // end the turn and select the next one in the same transaction
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

    case 'ADD_CONDITION':
      live(cmd.combatantId);
      if (cmd.sourceCombatantId) get(cmd.sourceCombatantId);
      s.conditions.push({
        id: ctx.newId(), targetCombatantId: cmd.combatantId, conditionKey: cmd.conditionKey,
        sourceCombatantId: cmd.sourceCombatantId ?? null, sourceLabel: cmd.sourceLabel, notes: cmd.notes,
      });
      affected.push(cmd.combatantId);
      break;
    case 'REMOVE_CONDITION': {
      const cond = s.conditions.find((c) => c.id === cmd.applicationId) ?? fail('NOT_FOUND', 'Condition application not found');
      s.conditions = s.conditions.filter((c) => c !== cond);
      affected.push(cond.targetCombatantId);
      break;
    }
    case 'REMOVE_ALL_CONDITION_SOURCES':
      get(cmd.combatantId);
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
      break;
    }

    case 'NEXT_TURN':
      if (s.activeId) affected.push(s.activeId);
      advance(s);
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
      if (s.activeId === null) advance(s); // the paused active combatant was removed: select the next eligible one
      if (s.activeId === null) fail('INVALID_STATE', 'No eligible combatants. Add or reinstate a combatant, or change turn settings, then resume.');
      break;

    case 'COMPLETE_COMBAT':
      s.status = 'completed';
      s.completedAt = ctx.now;
      s.activeId = null;
      s.schedule = emptySchedule();
      break;

    case 'ARCHIVE_ENCOUNTER':
      if (s.status === 'active') fail('INVALID_STATE', 'Pause or complete the encounter before archiving it');
      s.archivedAt ??= ctx.now;
      break;
  }

  s.version += 1;
  s.updatedAt = ctx.now;
  return { state: s, affectedIds: affected };
}

// ---------- snapshot / duplicate ----------
export function toSnapshot(s: EncounterState): EncounterSnapshot {
  const combatants = s.combatants
    .map((c): CombatantDto => ({ ...c, eligible: isEligible(c, s.skipZeroHpEnemies) }))
    .sort((a, b) =>
      (a.initiativeTotal === null ? 1 : 0) - (b.initiativeTotal === null ? 1 : 0) ||
      (b.initiativeTotal ?? 0) - (a.initiativeTotal ?? 0) || a.tieRank - b.tieRank || (a.id < b.id ? -1 : 1));
  return {
    id: s.id, name: s.name, notes: s.notes, status: s.status, round: s.round, activeCombatantId: s.activeId,
    schedule: s.schedule, canPreviousTurn: s.checkpoint !== null, skipZeroHpEnemies: s.skipZeroHpEnemies,
    version: s.version, rulesVersion: s.rulesVersion, combatants, conditions: s.conditions,
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
      if (target) copy.conditions.push({ ...k, id: ctx.newId(), targetCombatantId: target, sourceCombatantId: (k.sourceCombatantId && ids.get(k.sourceCombatantId)) || null });
    }
  }
  return copy;
}
