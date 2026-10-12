import { expect, it } from 'vitest';
import { applyCommand, newEncounter, toSnapshot } from '../domain/encounter';
import { conditionDuration, conditionDurationDescription, durationDescription, timingAnnouncement } from './timing';

it('describes expiry previews and announces pending, acknowledged, and resolved reminders from snapshots', () => {
  let id = 0;
  const ctx = { now: 1000, newId: () => `id-${++id}`, template: () => undefined, otherActive: null };
  let s = newEncounter('Timing', ctx);
  s = applyCommand(s, { type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ quantity: 1, initiative: { mode: 'total', total: 10 }, adhoc: {
    name: 'Mage', kind: 'player', maxHp: 20, startingHp: null, startingTempHp: 0, armorClass: 12, initiativeModifier: 0, speedFt: 30, notes: '', className: null, level: null, passivePerception: null,
  } }] }, ctx).state;
  s = applyCommand(s, { type: 'START_COMBAT' }, ctx).state;
  const mage = s.combatants[0].id;
  s = applyCommand(s, { type: 'START_CONCENTRATION', combatantId: mage, name: 'Fear' }, ctx).state;
  s = applyCommand(s, { type: 'ADD_CONDITION', combatantId: mage, conditionKey: 'frightened', sourceLabel: 'Fear', notes: '', effectId: s.concentrations[0].linkedEffects[0].id }, ctx).state;
  expect(conditionDuration(toSnapshot(s), s.conditions[0])).toEqual({ kind: 'concentration', concentrationId: s.concentrations[0].id });
  expect(conditionDurationDescription(toSnapshot(s), s.conditions[0])).toBe('Ends with Fear');
  s = applyCommand(s, { type: 'ADD_CONDITION', combatantId: mage, conditionKey: 'poisoned', sourceLabel: '', notes: '', duration: { kind: 'rounds', count: 2, anchorCombatantId: null, phase: 'start' } }, ctx).state;
  expect(conditionDurationDescription(toSnapshot(s), s.conditions[1])).toBe('Ends in round 3 at round start');
  expect(durationDescription(toSnapshot(s), { kind: 'rounds', count: 2, anchorCombatantId: null, phase: 'start' })).toBe('Ends in round 3 at round start');
  expect(durationDescription(toSnapshot(s), { kind: 'next-turn', anchorCombatantId: mage, phase: 'end' }, null, true)).toContain('turn already started');
  s = applyCommand(s, { type: 'CREATE_REMINDER', reminder: { name: 'Recharge', notes: 'Roll manually', kind: 'feature', trigger: { kind: 'turn', anchorCombatantId: mage, phase: 'start' }, repeat: true, effectId: null } }, ctx).state;
  const before = toSnapshot(s);
  s = applyCommand(s, { type: 'NEXT_TURN' }, ctx).state;
  expect(timingAnnouncement(before, toSnapshot(s))).toContain('Reminder pending: Recharge. Roll manually');
  const pending = toSnapshot(s);
  s = applyCommand(s, { type: 'ACKNOWLEDGE_REMINDER', occurrenceId: s.timing.occurrences[0].id }, ctx).state;
  expect(timingAnnouncement(pending, toSnapshot(s))).toBe('Recharge: acknowledged.');
  const acknowledged = toSnapshot(s);
  s = applyCommand(s, { type: 'RESOLVE_REMINDER', occurrenceId: s.timing.occurrences[0].id, outcome: 'done' }, ctx).state;
  expect(timingAnnouncement(acknowledged, toSnapshot(s))).toBe('Recharge: resolved, done.');
});
