import { describe, expect, it } from 'vitest';
import { CombatantFields, EncounterCommand, InitiativeEntry, type CombatantFields as Fields } from '../shared/contract';
import { applyCommand, duplicateEncounter, newEncounter, toSnapshot, type EncounterState } from './encounter';
import { AppError } from './errors';

let counter = 0;
const newId = () => `id-${++counter}`;
const templates: Record<string, Fields> = {};
const ctx = (otherActive: string | null = null) => ({ now: 1000, newId, template: (id: string) => templates[id], otherActive });
type Cmd = EncounterCommand;
const act = (s: EncounterState, cmd: Cmd, otherActive: string | null = null) => applyCommand(s, cmd, ctx(otherActive)).state;
const fields = (name: string, over: Partial<Fields> = {}): Fields => ({
  kind: 'enemy', name, maxHp: 20, startingHp: null, startingTempHp: 0, armorClass: 12, initiativeModifier: 3,
  speedFt: 30, className: null, level: null, passivePerception: null, notes: '', ...over,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof AppError) return e.code; throw e; }
  return 'none';
};

/** Draft encounter with one combatant per spec (initiative entered as a total). Returns ids by name. */
function setup(specs: { name: string; init: number | null; over?: Partial<Fields> }[]) {
  let s = newEncounter('Fight', ctx());
  const ids: Record<string, string> = {};
  for (const { name, init, over } of specs) {
    s = act(s, {
      type: 'ADD_COMBATANTS', joinPolicy: 'next-round',
      entries: [{ adhoc: fields(name, over), quantity: 1, initiative: init === null ? undefined : { mode: 'total', total: init } }],
    });
    ids[name] = s.combatants.at(-1)!.id;
  }
  return { s, ids };
}
const started = (specs: Parameters<typeof setup>[0]) => {
  const { s, ids } = setup(specs);
  return { s: act(s, { type: 'START_COMBAT' }), ids };
};
const next = (s: EncounterState) => act(s, { type: 'NEXT_TURN' });
const hp = (s: EncounterState, id: string) => {
  const c = s.combatants.find((c) => c.id === id)!;
  return `${c.currentHp}/${c.tempHp}`;
};
const order = (s: EncounterState) => [s.activeId, ...s.schedule.pendingIds];
/** Combatant HP setup in a draft: max, current, temp. */
const withHp = (s: EncounterState, id: string, max: number, cur: number, temp: number) => {
  s = act(s, { type: 'SET_MAX_HP', combatantId: id, value: max });
  s = act(s, { type: 'SET_HP', combatantId: id, value: cur });
  return act(s, { type: 'SET_TEMP_HP', combatantId: id, value: temp });
};

describe('HP (PRD 5.2)', () => {
  const cases: [string, [number, number, number], Cmd, string][] = [
    ['7 damage', [20, 20, 5], { type: 'APPLY_DAMAGE', combatantId: 'X', amount: 7 }, '18/0'],
    ['3 damage', [20, 20, 5], { type: 'APPLY_DAMAGE', combatantId: 'X', amount: 3 }, '20/2'],
    ['12 damage to 3 HP', [3, 20, 0], { type: 'APPLY_DAMAGE', combatantId: 'X', amount: 12 }, '0/0'],
    ['9 healing', [16, 20, 7], { type: 'APPLY_HEALING', combatantId: 'X', amount: 9 }, '20/7'],
    ['grant 8 temp at 0 HP', [0, 20, 0], { type: 'GRANT_TEMP_HP', combatantId: 'X', amount: 8, choice: 'keep' }, '0/8'],
    ['grant 12 replace', [20, 20, 10], { type: 'GRANT_TEMP_HP', combatantId: 'X', amount: 12, choice: 'replace' }, '20/12'],
    ['grant 7 keep', [20, 20, 10], { type: 'GRANT_TEMP_HP', combatantId: 'X', amount: 7, choice: 'keep' }, '20/10'],
    ['grant 5 replace (smaller)', [20, 20, 10], { type: 'GRANT_TEMP_HP', combatantId: 'X', amount: 5, choice: 'replace' }, '20/5'],
    ['damage equal to temp', [20, 20, 5], { type: 'APPLY_DAMAGE', combatantId: 'X', amount: 5 }, '20/0'],
  ];
  it.each(cases)('%s', (_n, [cur, max, temp], cmd, expected) => {
    // run while active so the starting values stay untouched
    let { s, ids } = started([{ name: 'A', init: 10 }, { name: 'B', init: 5 }]);
    s = { ...s, combatants: s.combatants.map((c) => (c.id === ids.A ? { ...c, maxHp: max, currentHp: cur, tempHp: temp } : c)) };
    const out = act(s, { ...cmd, combatantId: ids.A } as Cmd);
    expect(hp(out, ids.A)).toBe(expected);
    expect(out.combatants.find((c) => c.id === ids.A)!.startingHp).toBe(20);
  });

  it('direct HP correction is range-checked and leaves temp HP alone; damage at 0 HP is a no-op on HP', () => {
    let { s, ids } = started([{ name: 'A', init: 10 }]);
    expect(code(() => act(s, { type: 'SET_HP', combatantId: ids.A, value: 21 }))).toBe('VALIDATION');
    s = act(s, { type: 'GRANT_TEMP_HP', combatantId: ids.A, amount: 4, choice: 'keep' });
    s = act(s, { type: 'SET_HP', combatantId: ids.A, value: 0 });
    expect(hp(s, ids.A)).toBe('0/4');
    expect(hp(act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 9 }), ids.A)).toBe('0/0');
  });

  it('draft HP edits define starting values; running edits do not; max HP reduction clamps', () => {
    let { s, ids } = setup([{ name: 'A', init: 10 }]);
    s = withHp(s, ids.A, 30, 12, 3);
    let c = s.combatants[0];
    expect([c.startingHp, c.startingTempHp, c.currentHp, c.tempHp]).toEqual([12, 3, 12, 3]);
    s = act(s, { type: 'START_COMBAT' });
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 10 });
    c = s.combatants[0];
    expect([c.startingHp, c.currentHp, c.tempHp]).toEqual([12, 5, 0]);
    s = act(s, { type: 'SET_MAX_HP', combatantId: ids.A, value: 4 });
    c = s.combatants[0];
    expect([c.maxHp, c.currentHp, c.startingHp]).toEqual([4, 4, 4]);
  });
});

describe('initiative', () => {
  it('raw roll adds the modifier once; total mode adds none; negatives allowed; roll is range-checked', () => {
    let { s, ids } = setup([{ name: 'A', init: null }, { name: 'B', init: null }]);
    s = act(s, { type: 'SET_INITIATIVE', entries: [{ combatantId: ids.A, mode: 'roll', roll: 12 }, { combatantId: ids.B, mode: 'total', total: 12 }] });
    expect(s.combatants.map((c) => [c.initiativeTotal, c.initiativeRoll, c.initiativeMode])).toEqual([[15, 12, 'roll'], [12, null, 'total']]);
    s = act(s, { type: 'SET_INITIATIVE', entries: [{ combatantId: ids.B, mode: 'total', total: -2 }] });
    expect(s.combatants[1].initiativeTotal).toBe(-2);
    expect(InitiativeEntry.safeParse({ combatantId: crypto.randomUUID(), mode: 'roll', roll: 21 }).success).toBe(false);
    expect(InitiativeEntry.safeParse({ combatantId: crypto.randomUUID(), mode: 'roll', roll: 0 }).success).toBe(false);
  });

  it('ties keep insertion order, explicit tie order wins, and invalid groups are rejected', () => {
    let { s, ids } = setup([{ name: 'A', init: 10 }, { name: 'B', init: 10 }, { name: 'C', init: 10 }, { name: 'D', init: 5 }]);
    expect(toSnapshot(s).combatants.map((c) => c.name)).toEqual(['A', 'B', 'C', 'D']);
    s = act(s, { type: 'SET_TIE_ORDER', combatantIds: [ids.C, ids.A, ids.B] });
    expect(toSnapshot(s).combatants.map((c) => c.name)).toEqual(['C', 'A', 'B', 'D']);
    expect(code(() => act(s, { type: 'SET_TIE_ORDER', combatantIds: [ids.C, ids.A] }))).toBe('VALIDATION'); // partial group
    expect(code(() => act(s, { type: 'SET_TIE_ORDER', combatantIds: [ids.A, ids.D] }))).toBe('VALIDATION'); // different totals
    expect(order(act(s, { type: 'START_COMBAT' }))).toEqual([ids.C, ids.A, ids.B, ids.D]);
  });

  it('shared initiative keeps independent state', () => {
    let { s, ids } = setup([{ name: 'A', init: null }, { name: 'B', init: null }]);
    s = act(s, { type: 'SET_INITIATIVE', entries: [{ combatantId: ids.A, mode: 'total', total: 14 }, { combatantId: ids.B, mode: 'total', total: 14 }] });
    s = act(s, { type: 'START_COMBAT' });
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.B, amount: 5 });
    expect([hp(s, ids.A), hp(s, ids.B)]).toEqual(['20/0', '15/0']);
  });

  it('a mid-combat edit does not move the active turn or queue; the new value applies next round', () => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 15 }, { name: 'C', init: 10 }]);
    s = act(s, { type: 'SET_INITIATIVE', entries: [{ combatantId: ids.C, mode: 'total', total: 30 }] });
    expect(order(s)).toEqual([ids.A, ids.B, ids.C]);
    expect(s.schedule.orderKeys[ids.C].initiative).toBe(10);
    expect(s.combatants.find((c) => c.id === ids.C)!.initiativeTotal).toBe(30);
    s = next(next(next(s)));
    expect([s.round, ...order(s)]).toEqual([2, ids.C, ids.A, ids.B]);
  });
});

describe('Next Turn', () => {
  it('walks a full round and increments the round exactly once', () => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 15 }, { name: 'C', init: 10 }]);
    expect([s.round, s.activeId, s.status]).toEqual([1, ids.A, 'active']);
    s = next(s);
    expect([s.round, s.activeId, s.schedule.actedIds]).toEqual([1, ids.B, [ids.A]]);
    s = next(next(s));
    expect([s.round, s.activeId, s.schedule.actedIds, s.schedule.pendingIds]).toEqual([2, ids.A, [], [ids.B, ids.C]]);
  });

  it('single participant starts a new round every turn', () => {
    let { s } = started([{ name: 'A', init: 5 }]);
    s = next(next(s));
    expect(s.round).toBe(3);
  });

  it('pauses without looping when nobody is eligible, and resume explains/recovers', () => {
    let { s, ids } = started([{ name: 'A', init: 5 }]);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 99 });
    s = next(s);
    expect([s.status, s.activeId, s.round, s.schedule.pendingIds]).toEqual(['paused', null, 1, []]);
    expect(s.checkpoint).toBeNull();
    expect(code(() => act(s, { type: 'RESUME_COMBAT' }))).toBe('INVALID_STATE');
    s = act(s, { type: 'SET_TURN_POLICY', combatantId: ids.A, policy: 'include' });
    s = act(s, { type: 'RESUME_COMBAT' });
    expect([s.status, s.round, s.activeId]).toEqual(['active', 2, ids.A]);
  });

  it('zero-HP PC keeps its turn; zero-HP enemy is skipped unless included; skip setting is honored', () => {
    const specs = [{ name: 'PC', init: 20, over: { kind: 'player' as const } }, { name: 'Orc', init: 15 }, { name: 'Elf', init: 10, over: { kind: 'npc' as const } }];
    let { s, ids } = started(specs);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.PC, amount: 99 });
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Orc, amount: 99 });
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Elf, amount: 99 });
    expect(s.activeId).toBe(ids.PC); // HP change alone never advances
    s = next(s);
    expect(s.activeId).toBe(ids.Elf); // Orc dropped from pending; NPC at 0 HP stays eligible
    s = next(s);
    expect([s.round, order(s)]).toEqual([2, [ids.PC, ids.Elf]]);
    const orc = (st: EncounterState) => toSnapshot(st).combatants.find((c) => c.id === ids.Orc)!.eligible;
    expect(orc(s)).toBe(false);
    expect(orc(act(s, { type: 'SET_TURN_POLICY', combatantId: ids.Orc, policy: 'include' }))).toBe(true);
    expect(orc(act(s, { type: 'UPDATE_METADATA', skipZeroHpEnemies: false }))).toBe(true);
    const excluded = act(s, { type: 'SET_TURN_POLICY', combatantId: ids.PC, policy: 'exclude' });
    expect(toSnapshot(excluded).combatants.find((c) => c.id === ids.PC)!.eligible).toBe(false);
  });
});

describe('roster changes while running', () => {
  const three = () => started([{ name: 'A', init: 20 }, { name: 'B', init: 15 }, { name: 'C', init: 10 }]);
  const add = (s: EncounterState, name: string, total: number, joinPolicy: 'next-round' | 'current-round') =>
    act(s, { type: 'ADD_COMBATANTS', joinPolicy, entries: [{ adhoc: fields(name), quantity: 1, initiative: { mode: 'total', total } }] });

  it('joins next round by default', () => {
    let { s, ids } = three();
    s = add(s, 'D', 50, 'next-round');
    const d = s.combatants.at(-1)!.id;
    expect(order(s)).toEqual([ids.A, ids.B, ids.C]);
    s = next(next(next(s)));
    expect([s.round, ...order(s)]).toEqual([2, d, ids.A, ids.B, ids.C]);
  });

  it('requires initiative when joining a running encounter', () => {
    const { s } = three();
    expect(code(() => act(s, { type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ adhoc: fields('D'), quantity: 1 }] }))).toBe('VALIDATION');
  });

  it('current-round join is ordered against frozen keys and never precedes the active combatant', () => {
    let { s, ids } = three();
    s = add(s, 'D', 12, 'current-round');
    const d = s.combatants.at(-1)!.id;
    expect(order(s)).toEqual([ids.A, ids.B, d, ids.C]);
    s = add(s, 'E', 50, 'current-round');
    const e = s.combatants.at(-1)!.id;
    expect(order(s)).toEqual([ids.A, e, ids.B, d, ids.C]); // E is next, not before A
    s = add(s, 'F', 15, 'current-round'); // ties with B: lands after B
    expect(s.schedule.pendingIds.slice(0, 3)).toEqual([e, ids.B, s.combatants.at(-1)!.id]);
    expect(s.schedule.actedIds).toEqual([]);
  });

  it('removing the active combatant advances in the same command', () => {
    let { s, ids } = three();
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.A });
    expect([s.activeId, s.schedule.pendingIds, s.schedule.actedIds]).toEqual([ids.B, [ids.C], [ids.A]]);
  });

  it('removing pending drops it from the queue; removing an acted combatant keeps the round intact', () => {
    let { s, ids } = three();
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.C });
    expect(order(s)).toEqual([ids.A, ids.B]);
    s = next(s);
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.A });
    expect([s.activeId, s.schedule.pendingIds]).toEqual([ids.B, []]);
    s = next(s);
    expect([s.round, order(s)]).toEqual([2, [ids.B]]);
  });

  it('removing the active combatant while paused clears it; resume selects the next one', () => {
    let { s, ids } = three();
    s = act(s, { type: 'PAUSE_COMBAT' });
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.A });
    expect([s.status, s.activeId, s.schedule.pendingIds, s.schedule.actedIds]).toEqual(['paused', null, [ids.B, ids.C], [ids.A]]);
    s = act(s, { type: 'RESUME_COMBAT' });
    expect([s.status, s.activeId]).toEqual(['active', ids.B]);
  });

  it('resume keeps a still-valid active combatant', () => {
    let { s, ids } = three();
    s = act(act(s, { type: 'PAUSE_COMBAT' }), { type: 'RESUME_COMBAT' });
    expect([s.activeId, s.round]).toEqual([ids.A, 1]);
  });

  it('reinstating cannot grant a second turn or a retroactive turn', () => {
    let { s, ids } = three();
    s = next(s); // A acted, B active
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.A });
    s = act(s, { type: 'REINSTATE_COMBATANT', combatantId: ids.A, joinPolicy: 'current-round' });
    expect(order(s)).toEqual([ids.B, ids.C]);
    // a removed pending combatant may rejoin the current round in its place
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.C });
    s = act(s, { type: 'REINSTATE_COMBATANT', combatantId: ids.C, joinPolicy: 'current-round' });
    expect(order(s)).toEqual([ids.B, ids.C]);
    // next-round reinstate does not touch the current schedule
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.C });
    s = act(s, { type: 'REINSTATE_COMBATANT', combatantId: ids.C, joinPolicy: 'next-round' });
    expect(order(s)).toEqual([ids.B]);
    expect(code(() => act(s, { type: 'REINSTATE_COMBATANT', combatantId: ids.C, joinPolicy: 'next-round' }))).toBe('INVALID_STATE');
  });
});

describe('Previous Turn', () => {
  it('restores the schedule and creates a new version, only right after Next Turn', () => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 10 }]);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 6 });
    expect(toSnapshot(s).canPreviousTurn).toBe(false);
    expect(code(() => act(s, { type: 'PREVIOUS_TURN' }))).toBe('INVALID_STATE');
    s = next(s);
    expect(toSnapshot(s).canPreviousTurn).toBe(true);
    const v = s.version;
    s = act(s, { type: 'PREVIOUS_TURN' });
    expect([s.activeId, s.round, s.schedule.pendingIds, s.schedule.actedIds]).toEqual([ids.A, 1, [ids.B], []]);
    expect(s.version).toBe(v + 1);
    expect(hp(s, ids.A)).toBe('14/0'); // HP is not reversed
    expect(s.checkpoint).toBeNull(); // no second reversal
  });

  it('works across a round boundary', () => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 10 }]);
    s = next(next(s));
    expect([s.round, s.activeId]).toEqual([2, ids.A]);
    s = act(s, { type: 'PREVIOUS_TURN' });
    expect([s.round, s.activeId, s.schedule.actedIds, s.schedule.pendingIds]).toEqual([1, ids.B, [ids.A], []]);
  });

  it.each<[string, (ids: Record<string, string>) => Cmd]>([
    ['damage', (ids) => ({ type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 1 })],
    ['condition', (ids) => ({ type: 'ADD_CONDITION', combatantId: ids.A, conditionKey: 'prone', sourceLabel: '', notes: '' })],
    ['initiative edit', (ids) => ({ type: 'SET_INITIATIVE', entries: [{ combatantId: ids.A, mode: 'total', total: 1 }] })],
    ['pause', () => ({ type: 'PAUSE_COMBAT' })],
    ['metadata', () => ({ type: 'UPDATE_METADATA', notes: 'x' })],
  ])('an intervening %s disables it', (_n, mk) => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 10 }]);
    s = act(next(s), mk(ids));
    expect(toSnapshot(s).canPreviousTurn).toBe(false);
    expect(code(() => act(s, { type: 'PREVIOUS_TURN' }))).toBe('INVALID_STATE');
  });
});

describe('conditions and exhaustion', () => {
  it('keeps one record per source; removing one leaves the other; remove-all clears the key', () => {
    let { s, ids } = setup([{ name: 'A', init: 1 }, { name: 'B', init: 2 }]);
    const poison = (src: string): Cmd => ({ type: 'ADD_CONDITION', combatantId: ids.A, conditionKey: 'poisoned', sourceCombatantId: ids.B, sourceLabel: src, notes: '' });
    s = act(act(act(s, poison('trap')), poison('spider')), { type: 'ADD_CONDITION', combatantId: ids.A, conditionKey: 'prone', sourceLabel: '', notes: '' });
    expect(s.conditions.filter((c) => c.conditionKey === 'poisoned')).toHaveLength(2);
    s = act(s, { type: 'REMOVE_CONDITION', applicationId: s.conditions[0].id });
    expect(s.conditions.map((c) => c.conditionKey)).toEqual(['poisoned', 'prone']);
    s = act(s, poison('again'));
    s = act(s, { type: 'REMOVE_ALL_CONDITION_SOURCES', combatantId: ids.A, conditionKey: 'poisoned' });
    expect(s.conditions.map((c) => c.conditionKey)).toEqual(['prone']);
  });

  it('exhaustion is a 0-6 level separate from conditions', () => {
    const { s, ids } = setup([{ name: 'A', init: 1 }]);
    const out = act(s, { type: 'SET_EXHAUSTION', combatantId: ids.A, level: 6 });
    expect(out.combatants[0].exhaustionLevel).toBe(6);
    expect(out.conditions).toEqual([]);
    const id = crypto.randomUUID();
    expect(EncounterCommand.safeParse({ type: 'SET_EXHAUSTION', combatantId: id, level: 7 }).success).toBe(false);
    expect(EncounterCommand.safeParse({ type: 'SET_EXHAUSTION', combatantId: id, level: -1 }).success).toBe(false);
    expect(EncounterCommand.safeParse({ type: 'SET_EXHAUSTION', combatantId: id, level: 0 }).success).toBe(true);
  });
});

describe('lifecycle', () => {
  it('start requires initiative (naming offenders), an eligible combatant, and no other active encounter', () => {
    const { s } = setup([{ name: 'Ann', init: null }, { name: 'Bob', init: 4 }]);
    expect(() => act(s, { type: 'START_COMBAT' })).toThrow(/Ann/);
    expect(code(() => act(setup([{ name: 'Bob', init: 4 }]).s, { type: 'START_COMBAT' }, 'Other fight'))).toBe('INVALID_STATE');
    expect(code(() => act(newEncounter('Empty', ctx()), { type: 'START_COMBAT' }))).toBe('INVALID_STATE');
    const excluded = act(s, { type: 'SET_TURN_POLICY', combatantId: s.combatants[0].id, policy: 'exclude' });
    expect(act(excluded, { type: 'START_COMBAT' }).status).toBe('active');
  });

  it('resume enforces single-active; completed encounters only accept metadata and archive', () => {
    let { s, ids } = started([{ name: 'A', init: 5 }]);
    const paused = act(s, { type: 'PAUSE_COMBAT' });
    expect(code(() => act(paused, { type: 'RESUME_COMBAT' }, 'Other'))).toBe('INVALID_STATE');
    expect(code(() => act(s, { type: 'ARCHIVE_ENCOUNTER' }))).toBe('INVALID_STATE');
    expect(code(() => act(paused, { type: 'NEXT_TURN' }))).toBe('INVALID_STATE');
    s = act(s, { type: 'COMPLETE_COMBAT' });
    expect([s.status, s.activeId, s.completedAt]).toEqual(['completed', null, 1000]);
    expect(code(() => act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 1 }))).toBe('INVALID_STATE');
    expect(code(() => act(s, { type: 'UPDATE_COMBATANT', combatantId: ids.A, patch: { name: 'Z' } }))).toBe('INVALID_STATE');
    expect(act(s, { type: 'UPDATE_METADATA', name: 'Renamed' }).name).toBe('Renamed');
    expect(act(s, { type: 'ARCHIVE_ENCOUNTER' }).archivedAt).toBe(1000);
  });

  it('uses a custom instance name for a template entry, numbered when quantity > 1, without touching the template', () => {
    const templateId = crypto.randomUUID();
    templates[templateId] = fields('Train Guard');
    const s = act(newEncounter('E', ctx()), {
      type: 'ADD_COMBATANTS', joinPolicy: 'next-round',
      entries: [{ templateId, name: 'Train Guard North', quantity: 1 }, { templateId, name: 'Platform Guard', quantity: 2 }, { templateId, quantity: 1 }],
    });
    expect(s.combatants.map((c) => c.name)).toEqual(['Train Guard North', 'Platform Guard 1', 'Platform Guard 2', 'Train Guard']);
    expect(templates[templateId].name).toBe('Train Guard');
  });

  it('adds from templates as independent copies named by quantity; later template edits do not leak', () => {
    const templateId = crypto.randomUUID();
    templates[templateId] = fields('Guard', { maxHp: 11, startingHp: 8, startingTempHp: 2 });
    let s = act(newEncounter('E', ctx()), { type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ templateId, quantity: 3 }] });
    templates[templateId] = fields('Renamed', { maxHp: 99 });
    expect(s.combatants.map((c) => c.name)).toEqual(['Guard 1', 'Guard 2', 'Guard 3']);
    expect(new Set(s.combatants.map((c) => c.id)).size).toBe(3);
    expect(s.combatants.map((c) => [c.templateId, c.maxHp, c.currentHp, c.startingHp, c.tempHp])).toEqual(Array(3).fill([templateId, 11, 8, 8, 2]));
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: s.combatants[1].id, amount: 3 });
    expect(s.combatants.map((c) => c.currentHp)).toEqual([8, 7, 8]); // 2 temp HP absorbed first
    expect(code(() => act(s, { type: 'ADD_COMBATANTS', joinPolicy: 'next-round', entries: [{ templateId: crypto.randomUUID(), quantity: 1 }] }))).toBe('NOT_FOUND');
    delete templates[templateId];
  });

  it('a single copy keeps the plain name; snapshot sorts by initiative with unset last', () => {
    const { s } = setup([{ name: 'Low', init: -1 }, { name: 'None', init: null }, { name: 'High', init: 9 }]);
    expect(toSnapshot(s).combatants.map((c) => c.name)).toEqual(['High', 'Low', 'None']);
  });

  it('contract: adhoc fields validate', () => {
    expect(CombatantFields.safeParse({ ...fields('X'), maxHp: 0 }).success).toBe(false);
  });
});

describe('duplicate', () => {
  it('creates a fresh draft honoring the HP source, optionally copying conditions; original untouched', () => {
    let { s, ids } = started([{ name: 'A', init: 20 }, { name: 'B', init: 10 }]);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.A, amount: 7 });
    s = act(s, { type: 'ADD_CONDITION', combatantId: ids.A, conditionKey: 'prone', sourceCombatantId: ids.B, sourceLabel: 'x', notes: '' });
    s = act(s, { type: 'SET_EXHAUSTION', combatantId: ids.A, level: 2 });
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.B });
    const before = JSON.stringify(s);

    const fresh = duplicateEncounter(s, { hpSource: 'starting', copyConditions: false }, ctx());
    expect([fresh.name, fresh.status, fresh.round, fresh.activeId, fresh.version, fresh.checkpoint]).toEqual(['Fight (copy)', 'draft', 0, null, 1, null]);
    expect(fresh.schedule).toEqual({ pendingIds: [], actedIds: [], orderKeys: {} });
    expect(fresh.id).not.toBe(s.id);
    expect(fresh.combatants).toHaveLength(1); // removed combatants are not copied
    expect(fresh.combatants[0].id).not.toBe(ids.A);
    expect([fresh.combatants[0].currentHp, fresh.combatants[0].initiativeTotal, fresh.combatants[0].exhaustionLevel]).toEqual([20, null, 0]);
    expect(fresh.conditions).toEqual([]);

    const injured = duplicateEncounter(s, { name: 'Round two', hpSource: 'current', copyConditions: true }, ctx());
    expect(injured.name).toBe('Round two');
    expect([injured.combatants[0].currentHp, injured.combatants[0].startingHp, injured.combatants[0].exhaustionLevel]).toEqual([13, 13, 2]);
    expect(injured.conditions).toHaveLength(1);
    expect([injured.conditions[0].targetCombatantId, injured.conditions[0].sourceCombatantId]).toEqual([injured.combatants[0].id, null]);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('concentration (PRD 15.1)', () => {
  const caster = () => started([{ name: 'Mage', init: 20 }, { name: 'Target', init: 10 }]);
  const begin = (s: EncounterState, combatantId: string, name = 'Hold Person', replace = false) =>
    act(s, { type: 'START_CONCENTRATION', combatantId, name, replace });

  it.each([[9, 10], [25, 12], [60, 30], [100, 30]])('creates DC %i damage -> %i from resolved damage, including temp HP', (damage, dc) => {
    let { s, ids } = caster();
    s = act(s, { type: 'SET_TEMP_HP', combatantId: ids.Mage, value: 200 });
    s = begin(s, ids.Mage);
    const prev = structuredClone(s);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount: damage });
    expect(s.concentrations[0].checks).toMatchObject([{ damage, dc }]);
    expect(s.combatants[0].currentHp).toBe(20);
    expect(prev.concentrations[0].checks).toEqual([]);
  });

  it('keeps separate durable prompts; corrections, healing and zero damage do not create checks', () => {
    let { s, ids } = caster();
    s = begin(s, ids.Mage);
    const boundary = { version: s.version, round: s.round, activeCombatantId: s.activeId };
    expect(s.concentrations[0].startBoundary).toEqual(boundary);
    for (const amount of [9, 25]) s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount });
    for (const cmd of [
      { type: 'SET_HP', combatantId: ids.Mage, value: 0 },
      { type: 'APPLY_HEALING', combatantId: ids.Mage, amount: 3 },
      { type: 'SET_MAX_HP', combatantId: ids.Mage, value: 12 },
      { type: 'SET_TEMP_HP', combatantId: ids.Mage, value: 20 },
      { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount: 0 },
    ] as Cmd[]) s = act(s, cmd);
    expect(s.concentrations[0].checks.map((c) => c.dc)).toEqual([10, 12]);
    expect(new Set(s.concentrations[0].checks.map((c) => c.id)).size).toBe(2);
    const { id, checks } = s.concentrations[0];
    s = act(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: id, checkId: checks[0].id, outcome: 'success' });
    expect(s.concentrations[0].checks).toEqual([checks[1]]);
    expect(code(() => act(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: id, checkId: checks[0].id, outcome: 'success' }))).toBe('NOT_FOUND');
    s = act(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: id, checkId: checks[1].id, outcome: 'failure' });
    expect(s.concentrations).toEqual([]);
  });

  it.each(['manual', 'death', 'replace', 'failure'] as const)('ends only linked applications on %s', (reason) => {
    let { s, ids } = caster();
    s = begin(s, ids.Mage);
    s = begin(s, ids.Target, 'Bless');
    const concentration = s.concentrations[0];
    s = act(s, { type: 'ADD_CONCENTRATION_EFFECT', concentrationId: concentration.id, name: 'Secondary effect' });
    for (const effect of s.concentrations[0].linkedEffects) {
      s = act(s, { type: 'ADD_CONDITION', combatantId: ids.Target, conditionKey: 'poisoned', sourceLabel: effect.name, notes: '', effectId: effect.id });
    }
    s = act(s, { type: 'ADD_CONDITION', combatantId: ids.Target, conditionKey: 'poisoned', sourceLabel: 'Independent poison', notes: '' });
    const unrelated = structuredClone(s.concentrations[1]);
    s = act(s, { type: 'ADD_CONDITION', combatantId: ids.Target, conditionKey: 'poisoned', sourceLabel: 'Unrelated spell', notes: '', effectId: unrelated.linkedEffects[0].id });
    if (reason === 'replace') {
      expect(code(() => begin(s, ids.Mage, 'Fly'))).toBe('INVALID_STATE');
      s = begin(s, ids.Mage, 'Fly', true);
    } else if (reason === 'failure') {
      s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount: 4 });
      s = act(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: concentration.id, checkId: s.concentrations[0].checks[0].id, outcome: 'failure' });
    } else s = act(s, { type: 'END_CONCENTRATION', concentrationId: concentration.id, reason });
    expect(s.conditions.map((c) => c.sourceLabel)).toEqual(['Independent poison', 'Unrelated spell']);
    expect(s.concentrations.find((c) => c.id === unrelated.id)).toEqual(unrelated);
    expect(s.concentrations.some((c) => c.id === concentration.id)).toBe(false);
  });

  it.each(['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'] as const)('ends concentration for effective %s without inventing a derived row', (conditionKey) => {
    let { s, ids } = caster();
    s = begin(s, ids.Mage);
    s = act(s, { type: 'ADD_CONDITION', combatantId: ids.Mage, conditionKey, sourceLabel: 'Enemy', notes: '' });
    expect(s.concentrations).toEqual([]);
    expect(s.conditions.map((c) => c.conditionKey)).toEqual([conditionKey]);
    expect(code(() => begin(s, ids.Mage))).toBe('INVALID_STATE');
  });

  it('requires an explicit keep/end choice on removal, and never clears temp HP', () => {
    let { s, ids } = caster();
    s = act(s, { type: 'SET_TEMP_HP', combatantId: ids.Mage, value: 8 });
    s = begin(s, ids.Mage);
    expect(code(() => act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.Mage }))).toBe('VALIDATION');
    const kept = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.Mage, concentrationPolicy: 'keep' });
    expect(kept.concentrations).toEqual(s.concentrations);
    s = act(s, { type: 'REMOVE_COMBATANT', combatantId: ids.Mage, concentrationPolicy: 'end' });
    expect(s.concentrations).toEqual([]);
    expect(s.combatants[0].tempHp).toBe(8);
  });

  it('keeps concentration checks through turn advance/reversal, but resolving a save clears Previous Turn', () => {
    let { s, ids } = caster();
    s = begin(s, ids.Mage);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount: 9 });
    const concentration = structuredClone(s.concentrations[0]);
    s = next(s);
    expect(s.concentrations).toEqual([concentration]);
    s = act(s, { type: 'PREVIOUS_TURN' });
    expect(s.concentrations).toEqual([concentration]);
    s = act(next(s), { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: concentration.id, checkId: concentration.checks[0].id, outcome: 'success' });
    expect(toSnapshot(s).canPreviousTurn).toBe(false);
  });

  it('preserves concentration on exclusion and completion, and makes completed saves read-only', () => {
    let { s, ids } = caster();
    s = begin(s, ids.Mage);
    s = act(s, { type: 'APPLY_DAMAGE', combatantId: ids.Mage, amount: 9 });
    const concentration = structuredClone(s.concentrations[0]);
    s = act(s, { type: 'SET_TURN_POLICY', combatantId: ids.Mage, policy: 'exclude' });
    expect(s.concentrations).toEqual([concentration]);
    s = act(s, { type: 'COMPLETE_COMBAT' });
    expect(s.concentrations).toEqual([concentration]);
    expect(code(() => act(s, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: concentration.id, checkId: concentration.checks[0].id, outcome: 'success' }))).toBe('INVALID_STATE');
    expect(code(() => act(s, { type: 'END_CONCENTRATION', concentrationId: concentration.id }))).toBe('INVALID_STATE');
  });

  it('rejects unknown effect links, and duplicates conditions without live concentration links', () => {
    let { s, ids } = caster();
    expect(code(() => act(s, { type: 'ADD_CONDITION', combatantId: ids.Target, conditionKey: 'poisoned', sourceLabel: '', notes: '', effectId: 'missing' }))).toBe('NOT_FOUND');
    s = begin(s, ids.Mage);
    s = act(s, { type: 'ADD_CONDITION', combatantId: ids.Target, conditionKey: 'poisoned', sourceLabel: 'Spell', notes: '', effectId: s.concentrations[0].linkedEffects[0].id });
    const copy = duplicateEncounter(s, { hpSource: 'starting', copyConditions: true }, ctx());
    expect(copy.concentrations).toEqual([]);
    expect(copy.conditions).toMatchObject([{ effectId: null }]);
  });
});
