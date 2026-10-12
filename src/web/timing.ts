import type { ConditionDto, EffectDuration, EncounterSnapshot, ReminderTrigger } from '../shared/contract';
import { expiryRound } from '../domain/timing';

export function conditionDuration(s: EncounterSnapshot, condition: ConditionDto): EffectDuration {
  const timer = s.timing.effects.find((e) => e.id === condition.effectId);
  if (timer) return timer.duration;
  const concentration = s.concentrations.find((c) => c.linkedEffects.some((e) => e.id === condition.effectId));
  return concentration ? { kind: 'concentration', concentrationId: concentration.id } : { kind: 'manual' };
}

export function conditionDurationDescription(s: EncounterSnapshot, condition: ConditionDto): string {
  const timer = s.timing.effects.find((e) => e.id === condition.effectId);
  return timer ? durationDescription(s, timer.duration, timer.expiresRound, timer.armedBoundaryId !== null) : durationDescription(s, conditionDuration(s, condition));
}

export function durationDescription(s: EncounterSnapshot, d: EffectDuration, round = expiryRound(s, d), armed = false): string {
  const name = (id: string) => s.combatants.find((c) => c.id === id)?.name ?? 'Creature';
  switch (d.kind) {
    case 'manual': return 'Ends manually';
    case 'next-turn': return armed && d.phase === 'end' ? `Ends at the end of ${name(d.anchorCombatantId)}'s turn already started` : `Ends at the ${d.phase} of ${name(d.anchorCombatantId)}'s next turn; their current turn does not count`;
    case 'rounds': return `Ends in round ${round} at ${d.anchorCombatantId ? `the ${d.phase} of ${name(d.anchorCombatantId)}'s turn` : `round ${d.phase}`}`;
    case 'concentration': return `Ends with ${s.concentrations.find((c) => c.id === d.concentrationId)?.name ?? 'concentration'}`;
    case 'save-ends': return `${d.ability} save${d.dc === null ? '' : ` · DC ${d.dc}`} at the target's turn ${d.phase}; success removes this condition source`;
    case 'encounter-end': return 'Ends when combat is completed';
  }
}

export function triggerDescription(s: EncounterSnapshot, t: ReminderTrigger): string {
  return t.kind === 'round' ? `Round ${t.phase}` : `${s.combatants.find((c) => c.id === t.anchorCombatantId)?.name ?? 'Creature'}'s turn ${t.phase}`;
}

export function timingAnnouncement(before: EncounterSnapshot | null, after: EncounterSnapshot): string {
  if (!before || before.id !== after.id) return '';
  const ended = before.timing.effects.filter((e) => !after.timing.effects.some((f) => f.id === e.id)).map((e) => `${e.name} ended; linked conditions removed.`);
  const pending = after.timing.occurrences.filter((o) => o.status === 'pending' && !before.timing.occurrences.some((p) => p.id === o.id)).map((o) => `Reminder pending: ${o.name}. ${o.notes}`);
  const updated = after.timing.occurrences.filter((o) => before.timing.occurrences.some((p) => p.id === o.id && p.status !== o.status)).map((o) => `${o.name}: ${o.status}${o.outcome ? `, ${o.outcome}` : ''}.`);
  return [...ended, ...pending, ...updated].join(' ');
}
