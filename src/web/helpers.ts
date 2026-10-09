// Small pure helpers (unit-tested in helpers.test.ts).
import { applyDamage, applyHealing, parseHpInput } from '../domain/hp';
import type { ConditionDto, EncounterCommand } from '../shared/contract';

type HpTarget = { id: string; name: string; currentHp: number; maxHp: number; tempHp: number };

export type HpPreview =
  | { ok: true; label: string; command: EncounterCommand }
  | { ok: false; label: string };

/** Preview for the quick HP entry. Returns null for empty input; never commits partial typing. */
export function previewHpInput(c: HpTarget, text: string): HpPreview | null {
  if (!text.trim()) return null;
  const input = parseHpInput(text);
  if (!input) return { ok: false, label: 'Enter -12 (damage), +8 (heal) or 15 (set current HP).' };
  const show = (r: { hp: number; tempHp: number }) => `${r.hp}/${c.maxHp} HP, ${r.tempHp} temp`;
  const cur = { hp: c.currentHp, tempHp: c.tempHp };
  if (input.type === 'damage') {
    return { ok: true, label: `${c.name}: ${input.amount} damage → ${show(applyDamage(cur, input.amount))}`, command: { type: 'APPLY_DAMAGE', combatantId: c.id, amount: input.amount } };
  }
  if (input.type === 'heal') {
    return { ok: true, label: `${c.name}: ${input.amount} healing → ${show(applyHealing(cur, c.maxHp, input.amount))}`, command: { type: 'APPLY_HEALING', combatantId: c.id, amount: input.amount } };
  }
  if (input.amount > c.maxHp) return { ok: false, label: `${c.name}: set HP ${input.amount} is out of range 0–${c.maxHp}.` };
  return { ok: true, label: `${c.name}: set HP to ${input.amount} → ${show({ hp: input.amount, tempHp: c.tempHp })}`, command: { type: 'SET_HP', combatantId: c.id, value: input.amount } };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type Badge = { key: string; label: string; count: number };

/** ONE effective badge per ordinary condition (with source count) plus a single exhaustion level badge. */
export function conditionBadges(conditions: Pick<ConditionDto, 'conditionKey'>[], exhaustionLevel: number): Badge[] {
  const byKey = new Map<string, number>();
  for (const c of conditions) byKey.set(c.conditionKey, (byKey.get(c.conditionKey) ?? 0) + 1);
  const out: Badge[] = [...byKey].map(([key, count]) => ({ key, label: cap(key), count }));
  if (exhaustionLevel > 0) out.push({ key: 'exhaustion', label: `Exhaustion ${exhaustionLevel}`, count: 1 });
  return out;
}

/** Blocky HP bar, e.g. ▮▮▮▯▯▯▯▯. Any HP above zero shows at least one block. */
export function hpBar(hp: number, max: number, len = 8): string {
  const filled = hp <= 0 || max <= 0 ? 0 : Math.min(len, Math.max(1, Math.round((hp / max) * len)));
  return '▮'.repeat(filled) + '▯'.repeat(len - filled);
}

/** Initiative command input from the entry mode and typed text; undefined if not a whole number (roll must be 1-20). */
export function initiativeInput(mode: 'total' | 'roll', text: string): { mode: 'total'; total: number } | { mode: 'roll'; roll: number } | undefined {
  const n = Number(text);
  if (text.trim() === '' || !Number.isInteger(n)) return undefined;
  if (mode === 'roll') return n >= 1 && n <= 20 ? { mode, roll: n } : undefined;
  return { mode, total: n };
}
