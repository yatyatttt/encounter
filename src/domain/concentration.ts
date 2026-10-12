import type { ConditionKey } from '../shared/contract';

// These 2024 conditions include Incapacitated. Keep explicit applications intact.
export const INCAPACITATING_CONDITIONS: readonly ConditionKey[] = ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'];

export const concentrationDc = (damage: number): number => Math.min(30, Math.max(10, Math.floor(damage / 2)));

export function isIncapacitated(conditions: { targetCombatantId: string; conditionKey: ConditionKey }[], combatantId: string): boolean {
  return conditions.some((c) => c.targetCombatantId === combatantId && INCAPACITATING_CONDITIONS.includes(c.conditionKey));
}
