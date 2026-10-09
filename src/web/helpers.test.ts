import { describe, expect, it } from 'vitest';
import { conditionBadges, hpBar, previewHpInput } from './helpers';

const guard = { id: 'g2', name: 'Guard 2', currentHp: 20, maxHp: 20, tempHp: 0 };

describe('previewHpInput', () => {
  it('previews damage through temp HP and names the target', () => {
    const p = previewHpInput({ ...guard, tempHp: 5 }, '-7');
    expect(p).toMatchObject({ ok: true, command: { type: 'APPLY_DAMAGE', amount: 7, combatantId: 'g2' } });
    expect(p!.label).toBe('Guard 2: 7 damage → 18/20 HP, 0 temp');
  });
  it('previews healing and absolute set; rejects out-of-range set', () => {
    expect(previewHpInput({ ...guard, currentHp: 3 }, '+8')!.label).toContain('11/20 HP');
    expect(previewHpInput(guard, '15')).toMatchObject({ ok: true, command: { type: 'SET_HP', value: 15 } });
    expect(previewHpInput(guard, '25')).toMatchObject({ ok: false });
  });
  it('never commits partial or invalid typing', () => {
    expect(previewHpInput(guard, '')).toBeNull();
    expect(previewHpInput(guard, '-')).toMatchObject({ ok: false });
    expect(previewHpInput(guard, '1x')).toMatchObject({ ok: false });
  });
});

describe('conditionBadges', () => {
  it('shows one badge per condition with a source count, plus exhaustion', () => {
    const b = conditionBadges([{ conditionKey: 'poisoned' }, { conditionKey: 'prone' }, { conditionKey: 'poisoned' }], 2);
    expect(b).toEqual([
      { key: 'poisoned', label: 'Poisoned', count: 2 },
      { key: 'prone', label: 'Prone', count: 1 },
      { key: 'exhaustion', label: 'Exhaustion 2', count: 1 },
    ]);
    expect(conditionBadges([], 0)).toEqual([]);
  });
});

describe('hpBar', () => {
  it('fills proportionally with a minimum of one block above zero', () => {
    expect(hpBar(20, 20)).toBe('▮▮▮▮▮▮▮▮');
    expect(hpBar(1, 100)).toBe('▮▯▯▯▯▯▯▯');
    expect(hpBar(0, 20)).toBe('▯▯▯▯▯▯▯▯');
  });
});
