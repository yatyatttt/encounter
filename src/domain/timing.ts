import type { BoundaryKind, EffectDto, EffectDuration, TimingDto, ReminderTrigger, ReminderOccurrence, EncounterSnapshot } from '../shared/contract';
import type { EncounterState } from './encounter';

export const emptyTiming = (): TimingDto => ({ boundaryId: 0, lastRoundEnd: 0, effects: [], reminders: [], occurrences: [] });
export type Boundary = { id: number; kind: BoundaryKind; round: number; combatantId: string | null };
type View = Pick<EncounterSnapshot, 'round' | 'schedule' | 'skipZeroHpEnemies'> & { combatants: Omit<EncounterSnapshot['combatants'][number], 'eligible'>[] };

export function anchorProblem(s: View, id: string): string | null {
  const c = s.combatants.find((c) => c.id === id);
  if (!c || c.removedAt !== null) return 'anchor removed';
  if (c.turnPolicy === 'exclude') return 'anchor excluded';
  if (c.initiativeTotal === null) return 'anchor has no initiative';
  if (c.kind === 'enemy' && c.turnPolicy === 'default' && s.skipZeroHpEnemies && c.currentHp === 0) return 'anchor skipped at 0 HP';
  return null;
}

export function effectReview(s: View, e: Pick<EffectDto, 'sourceCombatantId' | 'duration' | 'targetCombatantIds'>): string[] {
  const problems: string[] = [];
  const source = s.combatants.find((c) => c.id === e.sourceCombatantId);
  if (e.sourceCombatantId && (!source || source.removedAt !== null || source.turnPolicy === 'exclude')) problems.push('source removed or excluded');
  const d = e.duration;
  const anchors = d.kind === 'next-turn' || d.kind === 'rounds' ? (d.anchorCombatantId ? [d.anchorCombatantId] : []) : d.kind === 'save-ends' ? e.targetCombatantIds : [];
  for (const id of anchors) { const problem = anchorProblem(s, id); if (problem) problems.push(`${s.combatants.find((c) => c.id === id)?.name ?? 'Creature'}: ${problem}`); }
  return problems;
}

export function expiryRound(s: View, duration: EffectDuration): number | null {
  if (duration.kind !== 'rounds') return null;
  const { anchorCombatantId: anchor, phase, count } = duration;
  if (!anchor) return Math.max(1, s.round + count - (phase === 'end' ? 1 : 0));
  const first = s.round === 0 ? 1 : s.schedule.pendingIds.includes(anchor) ? s.round : s.round + 1;
  return first + count - 1;
}

export function endEffect(s: EncounterState, id: string, affected: string[]) {
  const effect = s.timing.effects.find((e) => e.id === id);
  if (!effect) return;
  affected.push(...effect.targetCombatantIds);
  s.conditions = s.conditions.filter((c) => c.effectId !== id);
  s.timing.effects = s.timing.effects.filter((e) => e.id !== id);
  for (const r of s.timing.reminders) if (r.effectId === id) r.enabled = false;
  // A save for an ended effect is moot. Already-triggered custom work still needs the DM.
  for (const o of s.timing.occurrences) if (o.effectId === id && o.reminderId === null && o.status !== 'resolved') { o.status = 'resolved'; o.outcome = 'effect-ended'; }
}

export function matchesTrigger(t: ReminderTrigger, b: Boundary): boolean {
  return t.kind === 'turn' ? b.combatantId === t.anchorCombatantId && b.kind === (t.phase === 'start' ? 'TURN_START' : 'TURN_END') : b.kind === (t.phase === 'start' ? 'ROUND_START' : 'ROUND_END');
}

export function processBoundary(s: EncounterState, b: Boundary, affected: string[], newId: () => string) {
  const activeEffects = new Map(s.timing.effects.map((e) => [e.id, e]));
  const enabledReminders = new Set(s.timing.reminders.filter((r) => r.enabled).map((r) => r.id));
  const occurrence = (fields: Omit<ReminderOccurrence, 'id' | 'boundaryId' | 'triggerKind' | 'round' | 'status' | 'outcome'>) => {
    const ownerId = fields.reminderId ?? fields.effectId;
    if (s.timing.occurrences.some((o) => (o.reminderId ?? o.effectId) === ownerId && o.boundaryId === b.id && o.triggerKind === b.kind)) return;
    s.timing.occurrences.push({ ...fields, id: newId(), boundaryId: b.id, triggerKind: b.kind, round: b.round, status: 'pending', outcome: null });
  };
  // Commands supply creation order. Reminders merely queue work; they never roll or apply damage.
  const items = [...s.timing.effects.map((e) => ({ effect: e, reminder: null, version: e.createdVersion })), ...s.timing.reminders.map((r) => ({ effect: null, reminder: r, version: r.createdVersion }))].sort((a, b) => a.version - b.version);
  for (const item of items) {
    if (item.reminder) {
      const r = item.reminder;
      if (!enabledReminders.has(r.id) || b.id <= r.createdBoundaryId || !matchesTrigger(r.trigger, b)) continue;
      if (r.trigger.kind === 'turn' && anchorProblem(s, r.trigger.anchorCombatantId)) continue;
      const linked = r.effectId ? activeEffects.get(r.effectId) : undefined;
      if (r.effectId !== null && (!linked || (r.trigger.kind === 'turn' && effectReview(s, linked).length))) continue;
      occurrence({ reminderId: r.id, effectId: r.effectId, targetCombatantId: b.combatantId, name: r.name, notes: r.notes, kind: r.kind });
      if (!r.repeat) r.enabled = false;
      continue;
    }
    const e = item.effect!;
    if (!s.timing.effects.some((f) => f.id === e.id)) continue;
    if (b.id <= e.createdBoundaryId) continue;
    const d = e.duration;
    // Round anchors can continue independently of a removed source. Creature anchors need review.
    const review = effectReview(s, d.kind === 'save-ends' && b.combatantId ? { ...e, targetCombatantIds: [b.combatantId] } : e);
    if (review.length && (d.kind === 'next-turn' || d.kind === 'save-ends' || (d.kind === 'rounds' && d.anchorCombatantId !== null))) continue;
    if (d.kind === 'next-turn' || d.kind === 'rounds') {
      const anchor = d.anchorCombatantId;
      if (anchor && b.kind === 'TURN_START' && b.combatantId === anchor) e.armedBoundaryId = b.id;
      const matches = anchor ? b.combatantId === anchor && b.kind === (d.phase === 'start' ? 'TURN_START' : 'TURN_END') : b.kind === (d.phase === 'start' ? 'ROUND_START' : 'ROUND_END');
      if (matches && (!anchor || d.phase === 'start' || e.armedBoundaryId !== null) && (d.kind === 'next-turn' || b.round >= e.expiresRound!)) endEffect(s, e.id, affected);
    } else if (d.kind === 'encounter-end' && b.kind === 'ENCOUNTER_END') endEffect(s, e.id, affected);
    else if (d.kind === 'save-ends' && b.combatantId && e.targetCombatantIds.includes(b.combatantId) && b.kind === (d.phase === 'start' ? 'TURN_START' : 'TURN_END')) {
      occurrence({ reminderId: null, effectId: e.id, targetCombatantId: b.combatantId, name: e.name, notes: `${d.ability} save${d.dc === null ? '' : ` · DC ${d.dc}`} — success removes linked condition sources on this target`, kind: 'saving-throw' });
    }
  }
  for (const o of s.timing.occurrences) {
    if (o.boundaryId === b.id && o.reminderId !== null && o.effectId && activeEffects.has(o.effectId) && !s.timing.effects.some((e) => e.id === o.effectId) && o.status !== 'resolved') {
      o.notes += '\nDuration also ended at this boundary; adjudicate the order before resolving this reminder.';
    }
  }
}
