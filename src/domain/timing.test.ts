import { describe, expect, it } from 'vitest';
import { applyCommand, newEncounter, toSnapshot, type EncounterState } from './encounter';
import type { EffectDuration, EncounterCommand } from '../shared/contract';
import { effectReview, processBoundary } from './timing';

let serial = 0;
const ctx = () => ({ now: 1000, newId: () => `id-${++serial}`, template: () => undefined, otherActive: null });
const act = (s: EncounterState, cmd: EncounterCommand) => applyCommand(s, cmd, ctx()).state;
function fight() {
  let s = newEncounter('Timers', ctx());
  for (const [name, total] of [['Mage', 20], ['Target', 10]] as const) s = act(s, {
    type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ quantity: 1, initiative: { mode: 'total', total }, adhoc: {
      name, kind: 'player', maxHp: 30, startingHp: null, startingTempHp: 0, armorClass: 12, initiativeModifier: 0,
      speedFt: 30, className: null, level: null, passivePerception: null, notes: '',
    } }],
  });
  s = act(s, { type: 'START_COMBAT' });
  return { s, mage: s.combatants[0].id, target: s.combatants[1].id };
}
const next = (s: EncounterState) => act(s, { type: 'NEXT_TURN' });
function effect(s: EncounterState, source: string, target: string, duration: EffectDuration) {
  return act(s, { type: 'CREATE_EFFECT', effect: { name: 'Spell', sourceCombatantId: source, targetCombatantIds: [target], duration } });
}

describe('boundary durations', () => {
  it.each(['start', 'end'] as const)('counts whole rounds at round %s, not each Next Turn', (phase) => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'rounds', count: 2, anchorCombatantId: null, phase });
    expect(s.timing.effects[0].expiresRound).toBe(phase === 'start' ? 3 : 2);
    for (let i = 0; i < 3; i++) { s = next(s); expect(s.timing.effects).toHaveLength(1); }
    s = next(s);
    expect(s.round).toBe(3);
    expect(s.timing.effects).toEqual([]);
  });

  it('a fixed creature duration uses the upcoming turn and an explicit expiry round', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'rounds', count: 2, anchorCombatantId: target, phase: 'end' });
    expect(s.timing.effects[0].expiresRound).toBe(2);
    s = next(next(next(s))); // Target in round 2
    expect(s.timing.effects).toHaveLength(1);
    s = next(s);
    expect(s.timing.effects).toEqual([]);
  });

  it('expires at the next anchor start, preserves unrelated conditions, and previews the transition', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'start' });
    const id = s.timing.effects[0].id;
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', effectId: id, sourceLabel: 'Spell', notes: '' });
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: 'Trap', notes: '' });
    expect(toSnapshot(s).nextTurnConsequences).toContain('Ends Spell');
    const before = structuredClone(s);
    s = next(s);
    expect(s.timing.effects).toEqual([]);
    expect(s.conditions.map((c) => c.sourceLabel)).toEqual(['Trap']);
    expect(toSnapshot(s).canPreviousTurn).toBe(false);
    expect(before.timing.effects).toHaveLength(1);
  });

  it('end of next turn applied during the anchor current turn waits for its following turn', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: mage, phase: 'end' });
    s = next(s); // current Mage end is not next Mage end
    expect(s.timing.effects).toHaveLength(1);
    s = next(s); // round 2 Mage start arms expiry
    expect(s.timing.effects).toHaveLength(1);
    s = next(s);
    expect(s.timing.effects).toEqual([]);
  });

  it('Previous Turn can reverse a start that only arms expiry, without making the following end premature', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'end' });
    s = next(s);
    expect(toSnapshot(s).canPreviousTurn).toBe(true);
    const boundary = s.timing.boundaryId;
    s = act(s, { type: 'PREVIOUS_TURN' });
    expect(s.timing.boundaryId).toBe(boundary);
    s = next(s);
    expect(s.timing.effects).toHaveLength(1);
    s = next(s);
    expect(s.timing.effects).toEqual([]);
  });

  it('flags excluded/removed anchors, emits no excluded turn, and keeps independent round timers moving', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'end' });
    s = effect(s, mage, target, { kind: 'rounds', count: 1, anchorCombatantId: null, phase: 'start' });
    s = act(s, { type: 'SET_TURN_POLICY', combatantId: target, policy: 'exclude' });
    expect(effectReview(s, s.timing.effects[0])).toContain('Target: anchor excluded');
    s = next(s); // Target skipped, round 2 Mage starts
    expect(s.timing.effects).toHaveLength(1);
    expect(s.timing.effects[0].armedBoundaryId).toBeNull();
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: mage });
    expect(effectReview(s, s.timing.effects[0])).toContain('source removed or excluded');
    expect(s.status).toBe('paused');
  });

  it('pauses creature timers after source removal and resumes them after an explicit source/anchor edit', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'start' });
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: mage }); // selects Target, no expiry on removed source
    expect(s.timing.effects).toHaveLength(1);
    const e = s.timing.effects[0];
    s = act(s, { type: 'UPDATE_EFFECT', effectId: e.id, effect: { name: e.name, sourceCombatantId: null, targetCombatantIds: [target], duration: e.duration } });
    expect(effectReview(s, s.timing.effects[0])).toEqual([]);
    s = next(s);
    expect(s.timing.effects).toEqual([]);
  });

  it('only selected encounter-end effects end at completion, including ones with a removed source', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'manual' });
    s = effect(s, mage, target, { kind: 'encounter-end' });
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: mage });
    s = act(s, { type: 'COMPLETE_COMBAT' });
    expect(s.timing.effects.map((e) => e.duration.kind)).toEqual(['manual']);
  });

  it('can keep an existing removed target when changing a reviewed effect to manual', () => {
    let { s, mage, target } = fight();
    s = effect(s, target, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'end' });
    const e = s.timing.effects[0];
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', effectId: e.id, sourceLabel: 'Spell', notes: '' });
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: target });
    s = act(s, { type: 'UPDATE_EFFECT', effectId: e.id, effect: { name: e.name, sourceCombatantId: null, targetCombatantIds: [target], duration: { kind: 'manual' } } });
    expect(effectReview(s, s.timing.effects[0])).toEqual([]);
    expect(s.conditions).toHaveLength(1);
    expect(() => effect(s, mage, target, { kind: 'manual' })).toThrow(/removed/);
    s = act(s, { type: 'END_EFFECT', effectId: e.id });
    expect(s.conditions).toEqual([]);
  });

  it('a general concentration duration and its reminder end with the concentration, preserving temp HP', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'START_CONCENTRATION', combatantId: mage, name: 'Bless' });
    s = effect(s, mage, target, { kind: 'concentration', concentrationId: s.concentrations[0].id });
    const id = s.timing.effects[0].id;
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Spell reminder', kind: 'feature', notes: '', effectId: id, trigger: { kind: 'turn', anchorCombatantId: target, phase: 'start' }, repeat: true } });
    s = next(s);
    s = act(s, { type: 'SET_TEMP_HP', combatantId: target, value: 8 });
    s = act(s, { type: 'END_CONCENTRATION', concentrationId: s.concentrations[0].id });
    expect(s.timing.effects).toEqual([]);
    expect(s.timing.reminders[0].enabled).toBe(false);
    expect(s.timing.occurrences[0]).toMatchObject({ status: 'pending', outcome: null }); // already-triggered work stays for the DM
    expect(s.combatants[1].tempHp).toBe(8);
  });
});

describe('condition durations', () => {
  it('adds a condition and its duration in one command, expiring only that source', () => {
    let { s, mage, target } = fight();
    const before = structuredClone(s);
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: 'Spell', sourceCombatantId: mage, notes: '', duration: { kind: 'next-turn', anchorCombatantId: target, phase: 'start' } });
    expect(s.version).toBe(before.version + 1);
    expect(s.conditions[0].effectId).toBe(s.timing.effects[0].id);
    expect(s.timing.effects[0].targetCombatantIds).toEqual([target]);
    expect(before.conditions).toEqual([]);
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: 'Trap', notes: '' });
    s = next(s);
    expect(s.conditions.map((c) => c.sourceLabel)).toEqual(['Trap']);
  });

  it('removing a timed condition stops future reminders and cancels its save-ends checks', () => {
    let { s, target } = fight();
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'frightened', sourceLabel: 'Fear', notes: '', duration: { kind: 'save-ends', phase: 'start', ability: 'wisdom', dc: 14 } });
    const c = s.conditions[0];
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Fear note', kind: 'note', notes: '', repeat: true, effectId: c.effectId, trigger: { kind: 'turn', anchorCombatantId: target, phase: 'start' } } });
    s = next(s);
    s = act(s, { type: 'REMOVE_CONDITION', applicationId: c.id });
    expect(s.conditions).toEqual([]);
    expect(s.timing.effects).toEqual([]);
    expect(s.timing.reminders[0].enabled).toBe(false);
    expect(s.timing.occurrences.map((o) => o.status)).toEqual(['resolved', 'pending']);
  });

  it('edits an individual duration without changing the condition ID or its associated reminders', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceCombatantId: mage, sourceLabel: 'Spell', notes: '', duration: { kind: 'next-turn', anchorCombatantId: target, phase: 'end' } });
    const c = s.conditions[0];
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Poison damage', kind: 'damage', notes: '', repeat: true, effectId: c.effectId, trigger: { kind: 'turn', anchorCombatantId: target, phase: 'end' } } });
    s = act(s, { type: 'UPDATE_CONDITION', applicationId: c.id, sourceCombatantId: null, sourceLabel: 'Corrected source', notes: 'DM decides', duration: { kind: 'manual' } });
    expect(s.conditions[0]).toMatchObject({ id: c.id, effectId: c.effectId, sourceCombatantId: null, sourceLabel: 'Corrected source' });
    expect(s.timing.effects[0].duration.kind).toBe('manual');
    expect(s.timing.reminders[0].enabled).toBe(true);
    s = next(next(s));
    expect(s.conditions).toHaveLength(1);
  });

  it('edits a legacy shared timer for one application without changing other targets', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'CREATE_EFFECT', effect: { name: 'Shared fear', sourceCombatantId: null, targetCombatantIds: [mage, target], duration: { kind: 'save-ends', ability: 'wisdom', dc: 14, phase: 'end' } } });
    const id = s.timing.effects[0].id;
    for (const combatantId of [mage, target]) s = act(s, { type: 'ADD_CONDITION', combatantId, conditionKey: 'frightened', sourceLabel: 'Fear', notes: '', effectId: id });
    const c = s.conditions[0];
    s = act(s, { type: 'UPDATE_CONDITION', applicationId: c.id, sourceCombatantId: null, sourceLabel: 'Fear', notes: '', duration: { kind: 'manual' } });
    expect(s.conditions[0].effectId).not.toBe(id);
    expect(s.conditions[1].effectId).toBe(id);
    expect(s.timing.effects[0].targetCombatantIds).toEqual([target]);
    expect(s.timing.effects[0].duration.kind).toBe('save-ends');
    expect(s.timing.effects[1].duration.kind).toBe('manual');
  });

  it('concentration duration links directly to its caster and Remove all clears only this condition type', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'START_CONCENTRATION', combatantId: mage, name: 'Spell' });
    const concentrationId = s.concentrations[0].id;
    for (const conditionKey of ['poisoned', 'frightened'] as const) s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey, sourceLabel: 'Spell', notes: '', duration: { kind: 'concentration', concentrationId } });
    expect(s.conditions[0].sourceCombatantId).toBe(mage);
    s = act(s, { type: 'REMOVE_ALL_CONDITION_SOURCES', combatantId: target, conditionKey: 'poisoned' });
    expect(s.conditions.map((c) => c.conditionKey)).toEqual(['frightened']);
    expect(s.timing.effects).toHaveLength(1);
    s = act(s, { type: 'END_CONCENTRATION', concentrationId });
    expect(s.conditions).toEqual([]);
  });

  it('can add a duration to an older manual condition on a removed target, then remove it', () => {
    let { s, target } = fight();
    s = act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: 'Trap', notes: '' });
    const applicationId = s.conditions[0].id;
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: target });
    s = act(s, { type: 'UPDATE_CONDITION', applicationId, sourceCombatantId: null, sourceLabel: 'Trap', notes: '', duration: { kind: 'rounds', count: 2, anchorCombatantId: null, phase: 'start' } });
    expect(s.conditions[0].id).toBe(applicationId);
    expect(s.timing.effects[0].targetCombatantIds).toEqual([target]);
    expect(() => act(s, { type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: '', notes: '' })).toThrow(/removed/);
    s = act(s, { type: 'REMOVE_CONDITION', applicationId });
    expect(s.conditions).toEqual([]);
    expect(s.timing.effects).toEqual([]);
  });
});

describe('reminders', () => {
  it('keeps same-boundary associated reminders for manual ordering even when the effect expires first', () => {
    let { s, mage, target } = fight();
    s = effect(s, mage, target, { kind: 'next-turn', anchorCombatantId: target, phase: 'end' });
    const effectId = s.timing.effects[0].id;
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Burning ends', notes: 'Apply 1d6 manually', kind: 'damage', effectId, repeat: true, trigger: { kind: 'turn', anchorCombatantId: target, phase: 'end' } } });
    s = next(next(s));
    expect(s.timing.effects).toEqual([]);
    expect(s.timing.occurrences).toMatchObject([{ status: 'pending', name: 'Burning ends' }]);
    expect(s.timing.occurrences[0].notes).toContain('adjudicate');
    expect(s.timing.reminders[0].enabled).toBe(false);
    expect(s.combatants[1].currentHp).toBe(30);
  });
  it.each([false, true])('does not repeat an occurrence for the same identity (repeat = %s)', (repeat) => {
    let { s, target } = fight();
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Once', kind: 'note', notes: '', trigger: { kind: 'turn', anchorCombatantId: target, phase: 'start' }, repeat, effectId: null } });
    s = next(s);
    const b = { id: s.timing.boundaryId, kind: 'TURN_START' as const, round: s.round, combatantId: target };
    processBoundary(s, b, [], ctx().newId);
    expect(s.timing.occurrences).toHaveLength(1);
    s = next(next(s));
    expect(s.timing.occurrences).toHaveLength(repeat ? 2 : 1);
    expect(s.timing.reminders[0].enabled).toBe(repeat);
  });

  it('orders turn end, round end, round start, then turn start, and creates same-boundary reminders in creation order', () => {
    let { s, mage } = fight();
    s = next(s); // Target active
    for (const [name, trigger] of [
      ['Mage start', { kind: 'turn', anchorCombatantId: mage, phase: 'start' }],
      ['Round start', { kind: 'round', phase: 'start' }],
      ['Target end 1', { kind: 'turn', anchorCombatantId: s.activeId!, phase: 'end' }],
      ['Target end 2', { kind: 'turn', anchorCombatantId: s.activeId!, phase: 'end' }],
      ['Round end', { kind: 'round', phase: 'end' }],
    ] as const) s = act(s, { type: 'CREATE_REMINDER', reminder: { name, trigger, kind: 'note', notes: '', repeat: true, effectId: null } });
    s = next(s);
    expect(s.timing.occurrences.map((o) => o.name)).toEqual(['Target end 1', 'Target end 2', 'Round end', 'Round start', 'Mage start']);
    expect(new Set(s.timing.occurrences.map((o) => o.boundaryId)).size).toBe(4);
    expect(toSnapshot(s).canPreviousTurn).toBe(false);
  });

  it('turn reminders pause on exclusion, while round reminders continue and pending items stay', () => {
    let { s, target } = fight();
    for (const trigger of [{ kind: 'turn' as const, anchorCombatantId: target, phase: 'start' as const }, { kind: 'round' as const, phase: 'start' as const }]) s = act(s, { type: 'CREATE_REMINDER', reminder: { name: trigger.kind, notes: '', kind: 'note', trigger, repeat: true, effectId: null } });
    s = next(s);
    s = act(s, { type: 'SET_TURN_POLICY', combatantId: target, policy: 'exclude' });
    s = next(next(s));
    expect(s.timing.occurrences.map((o) => o.name)).toEqual(['turn', 'round', 'round']);
    const first = s.timing.reminders[0];
    s = act(s, { type: 'DISABLE_REMINDER', reminderId: first.id });
    expect(s.timing.occurrences[0]).toMatchObject({ status: 'resolved', outcome: 'disabled' });
    expect(s.timing.occurrences[1].status).toBe('pending');
  });
  it('persists separate pending, acknowledged and resolved occurrences without applying suggested damage', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'CREATE_REMINDER', reminder: { name: 'Burning', notes: 'Roll 1d6 fire damage, then apply it manually', kind: 'damage', trigger: { kind: 'turn', anchorCombatantId: target, phase: 'start' }, repeat: true, effectId: null } });
    expect(toSnapshot(s).nextTurnConsequences).toContain('Reminder: Burning');
    s = next(s);
    expect(s.timing.occurrences).toMatchObject([{ name: 'Burning', status: 'pending', triggerKind: 'TURN_START' }]);
    expect(s.combatants.find((c) => c.id === target)!.currentHp).toBe(30);
    const occurrence = s.timing.occurrences[0];
    s = act(s, { type: 'ACKNOWLEDGE_REMINDER', occurrenceId: occurrence.id });
    expect(s.timing.occurrences[0].status).toBe('acknowledged');
    s = next(next(s));
    expect(s.timing.occurrences.map((o) => o.status)).toEqual(['acknowledged', 'pending']);
    s = act(s, { type: 'RESOLVE_REMINDER', occurrenceId: occurrence.id, outcome: 'done' });
    expect(s.timing.occurrences[0]).toMatchObject({ status: 'resolved', outcome: 'done' });
    expect(s.timing.occurrences[1].status).toBe('pending');
    expect(s.timing.boundaryId).toBeGreaterThan(occurrence.boundaryId);
  });

  it('save ends prompts per target, keeps a failure, and ends only the successful target applications', () => {
    let { s, mage, target } = fight();
    s = act(s, { type: 'CREATE_EFFECT', effect: { name: 'Fear', sourceCombatantId: mage, targetCombatantIds: [mage, target], duration: { kind: 'save-ends', phase: 'end', ability: 'wisdom', dc: 14 } } });
    const id = s.timing.effects[0].id;
    for (const combatantId of [mage, target]) s = act(s, { type: 'ADD_CONDITION', combatantId, conditionKey: 'frightened', effectId: id, sourceLabel: 'Fear', notes: '' });
    s = next(s);
    expect(s.timing.occurrences[0]).toMatchObject({ targetCombatantId: mage, status: 'pending' });
    s = act(s, { type: 'RESOLVE_REMINDER', occurrenceId: s.timing.occurrences[0].id, outcome: 'failure' });
    expect(s.conditions).toHaveLength(2);
    s = next(s);
    s = act(s, { type: 'RESOLVE_REMINDER', occurrenceId: s.timing.occurrences[1].id, outcome: 'success' });
    expect(s.timing.effects[0].targetCombatantIds).toEqual([mage]);
    expect(s.conditions.map((c) => c.targetCombatantId)).toEqual([mage]);
  });
});
