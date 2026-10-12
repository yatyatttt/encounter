import { expect, it } from 'vitest';
import { applyCommand, newEncounter, toSnapshot } from '../domain/encounter';
import { concentrationAnnouncement } from './store';

it('announces a concentration save when temp HP absorbs the damage, and then the recorded outcome', () => {
  let nextId = 0;
  const ctx = { now: 1000, newId: () => `id-${++nextId}`, template: () => undefined, otherActive: null };
  let s = newEncounter('Fight', ctx);
  s = applyCommand(s, {
    type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ quantity: 1, adhoc: {
      kind: 'player', name: 'Mage', maxHp: 20, startingHp: null, startingTempHp: 30,
      armorClass: 12, initiativeModifier: 2, speedFt: 30, notes: '', className: null, level: null, passivePerception: null,
    } }],
  }, ctx).state;
  const mageId = s.combatants[0].id;
  const before = toSnapshot(s);
  s = applyCommand(s, { type: 'START_CONCENTRATION', combatantId: mageId, name: 'Bless' }, ctx).state;
  expect(concentrationAnnouncement(before, toSnapshot(s))).toContain('Mage: concentrating on Bless.');
  const concentrating = toSnapshot(s);
  s = applyCommand(s, { type: 'APPLY_DAMAGE', combatantId: mageId, amount: 25 }, ctx).state;
  expect(concentrationAnnouncement(concentrating, toSnapshot(s))).toContain('25 damage, DC 12 Constitution save pending.');
  const damaged = toSnapshot(s);
  s = applyCommand(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: s.concentrations[0].id, checkId: s.concentrations[0].checks[0].id, outcome: 'success' }, ctx).state;
  expect(concentrationAnnouncement(damaged, toSnapshot(s))).toContain('concentration check succeeded');
  const success = toSnapshot(s);
  s = applyCommand(s, { type: 'END_CONCENTRATION', concentrationId: s.concentrations[0].id }, ctx).state;
  expect(concentrationAnnouncement(success, toSnapshot(s))).toContain('Bless concentration ended');
});
