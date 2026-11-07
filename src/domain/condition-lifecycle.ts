// Condition timers and concentration cleanup mutate only the cloned command state.
import type { ConditionDto, EffectDuration, EncounterCommand } from '../shared/contract';
import type { EncounterState } from './encounter';
import { fail } from './errors';
import { endEffect, expiryRound } from './timing';

export function getCombatant(state: EncounterState, id: string) {
  return state.combatants.find((c) => c.id === id) ?? fail('NOT_FOUND', 'Combatant not found');
}

export function getLiveCombatant(state: EncounterState, id: string) {
  const combatant = getCombatant(state, id);
  if (combatant.removedAt !== null)
    fail('INVALID_STATE', `${combatant.name} has been removed from this encounter`);
  return combatant;
}

export function getConcentration(state: EncounterState, id: string) {
  return state.concentrations.find((c) => c.id === id) ?? fail('NOT_FOUND', 'Concentration not found');
}

export function validateEffect(
  state: EncounterState,
  effect: Extract<EncounterCommand, { type: 'CREATE_EFFECT' }>['effect'],
  existingTargets: string[] = [],
) {
  if (effect.sourceCombatantId) getCombatant(state, effect.sourceCombatantId);
  if (new Set(effect.targetCombatantIds).size !== effect.targetCombatantIds.length)
    fail('VALIDATION', 'Effect targets must be unique');
  // Existing tombstoned targets may be retained for review/reinstatement; new targets must be live.
  effect.targetCombatantIds.forEach((id) =>
    existingTargets.includes(id) ? getCombatant(state, id) : getLiveCombatant(state, id),
  );
  const duration = effect.duration;
  if ((duration.kind === 'next-turn' || duration.kind === 'rounds') && duration.anchorCombatantId)
    getCombatant(state, duration.anchorCombatantId);
  if (duration.kind === 'concentration') {
    const conc = getConcentration(state, duration.concentrationId);
    if (effect.sourceCombatantId !== conc.combatantId)
      fail('VALIDATION', 'A concentration effect must use its caster as source');
  }
}

export function releaseConditionTimer(
  state: EncounterState,
  affected: string[],
  condition: ConditionDto,
) {
  const id = condition.effectId;
  condition.effectId = null;
  const timer = state.timing.effects.find((e) => e.id === id);
  if (!timer) return; // legacy concentration links have no independent timer
  const remaining = state.conditions.filter((c) => c.effectId === id);
  if (!remaining.length) endEffect(state, timer.id, affected);
  else if (!remaining.some((c) => c.targetCombatantId === condition.targetCombatantId)) {
    timer.targetCombatantIds = timer.targetCombatantIds.filter(
      (target) => target !== condition.targetCombatantId,
    );
    for (const occurrence of state.timing.occurrences)
      if (
        occurrence.reminderId === null &&
        occurrence.effectId === id &&
        occurrence.targetCombatantId === condition.targetCombatantId &&
        occurrence.status !== 'resolved'
      ) {
        occurrence.status = 'resolved';
        occurrence.outcome = 'effect-ended';
      }
  }
}

export function setConditionDuration(
  state: EncounterState,
  affected: string[],
  newId: () => string,
  condition: ConditionDto,
  duration: EffectDuration,
) {
  const old = state.timing.effects.find((e) => e.id === condition.effectId);
  const ownTimer =
    old &&
    old.targetCombatantIds.length === 1 &&
    state.conditions.filter((c) => c.effectId === old.id).length === 1
      ? old
      : undefined;
  if (!ownTimer) releaseConditionTimer(state, affected, condition); // editing a legacy shared duration must not change other applications
  if (duration.kind === 'concentration')
    condition.sourceCombatantId = getConcentration(state, duration.concentrationId).combatantId;
  const conditionName = condition.conditionKey[0].toUpperCase() + condition.conditionKey.slice(1);
  const targetName = getCombatant(state, condition.targetCombatantId).name;
  const sourceSuffix = condition.sourceLabel ? ` · ${condition.sourceLabel}` : '';
  const input = {
    name: `${conditionName} · ${targetName}${sourceSuffix}`.slice(0, 200),
    sourceCombatantId: condition.sourceCombatantId,
    targetCombatantIds: [condition.targetCombatantId],
    duration,
  };
  validateEffect(state, input, [condition.targetCombatantId]); // this application may remain on a tombstoned target
  const timing = {
    createdVersion: state.version + 1,
    createdBoundaryId: state.timing.boundaryId,
    armedBoundaryId: null,
    expiresRound: expiryRound(state, duration),
  };
  if (ownTimer) {
    Object.assign(ownTimer, input, timing);
    for (const occurrence of state.timing.occurrences)
      if (occurrence.reminderId === null && occurrence.effectId === ownTimer.id && occurrence.status !== 'resolved') {
        occurrence.status = 'resolved';
        occurrence.outcome = 'effect-ended';
      }
  } else {
    if (state.timing.effects.length >= 500)
      fail('VALIDATION', 'At most 500 timed conditions per encounter');
    const timer = { ...input, ...timing, id: newId() };
    state.timing.effects.push(timer);
    condition.effectId = timer.id;
  }
}

export function endConcentration(state: EncounterState, affected: string[], id: string) {
  const c = getConcentration(state, id);
  const effectIds = new Set(c.linkedEffects.map((e) => e.id));
  affected.push(
    c.combatantId,
    ...state.conditions
      .filter((k) => k.effectId !== null && effectIds.has(k.effectId))
      .map((k) => k.targetCombatantId),
  );
  state.conditions = state.conditions.filter((k) => k.effectId === null || !effectIds.has(k.effectId));
  state.concentrations = state.concentrations.filter((k) => k.id !== id);
  for (const effect of [...state.timing.effects])
    if (effect.duration.kind === 'concentration' && effect.duration.concentrationId === id)
      endEffect(state, effect.id, affected);
}
