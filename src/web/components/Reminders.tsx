import type { ReminderOccurrence } from '../../shared/contract';
import { useState } from 'react';
import { useStore } from '@/store';
import { anchorProblem, effectReview } from '../../domain/timing';
import { triggerDescription } from '@/timing';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Confirm } from '@/components/ui/dialog';
import { SaveError } from '@/components/Save';
import { ReminderEditor } from '@/components/ReminderEditor';

export function ParticipationConditionsNotice({ combatantId }: { combatantId: string }) {
  const snap = useStore((s) => s.snapshot)!;
  const effects = snap.timing.effects.filter(
    (e) =>
      e.sourceCombatantId === combatantId ||
      ((e.duration.kind === 'next-turn' || e.duration.kind === 'rounds') &&
        e.duration.anchorCombatantId === combatantId) ||
      (e.duration.kind === 'save-ends' && e.targetCombatantIds.includes(combatantId)),
  );
  const reminders = snap.timing.reminders.filter(
    (r) => r.enabled && r.trigger.kind === 'turn' && r.trigger.anchorCombatantId === combatantId,
  );
  if (!effects.length && !reminders.length) return null;
  return (
    <p className="mt-3 text-xs text-warn">
      Condition durations and reminders involving this source or anchor stay for review:{' '}
      {[...effects, ...reminders].map((e) => e.name).join(', ')}. Creature timers wait while
      excluded or removed; whole-round timers continue independently. Edit the affected conditions
      or manage their reminders.
    </p>
  );
}

export function RemindersManager() {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const select = useStore((s) => s.select);
  const busy = useStore((s) => s.save === 'saving');
  const [addingReminder, setAddingReminder] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);
  const completed = snap.status === 'completed';
  const name = (id: string | null) =>
    snap.combatants.find((c) => c.id === id)?.name ?? 'No creature source';
  const pending = snap.timing.occurrences.filter((o) => o.status !== 'resolved');
  const resolved = snap.timing.occurrences.filter((o) => o.status === 'resolved');
  const scheduled = snap.timing.reminders.filter((r) => r.enabled);
  const unlinked = snap.timing.effects.filter(
    (e) => !snap.conditions.some((c) => c.effectId === e.id),
  );
  const reviews = snap.conditions.flatMap((c) => {
    const timer = snap.timing.effects.find((e) => e.id === c.effectId);
    return timer && effectReview(snap, timer).length ? [c] : [];
  });
  const reviewCount =
    reviews.length +
    scheduled.filter(
      (r) => r.trigger.kind === 'turn' && !!anchorProblem(snap, r.trigger.anchorCombatantId),
    ).length;
  return (
    <section
      aria-label="Reminders"
      className="flex flex-col gap-3 border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="label">Reminders · {pending.length} pending</h2>
        {reviewCount > 0 && <Badge tone="amber">Review required · {reviewCount}</Badge>}
        {!completed && (
          <Button
            variant="outline"
            disabled={busy || snap.timing.reminders.length >= 500}
            onClick={() => setAddingReminder(true)}
          >
            Add reminder
          </Button>
        )}
      </div>
      {reviews.length > 0 && (
        <div className="flex flex-col text-xs text-warn">
          {reviews.map((c) => (
            <button
              key={c.id}
              className="min-h-11 cursor-pointer text-left hover:text-primary"
              onClick={() => select(c.targetCombatantId)}
            >
              {name(c.targetCombatantId)} · {c.conditionKey} · duration needs review — open
              conditions
            </button>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <section aria-label="Pending reminders" className="border-l-2 border-warn pl-3">
          <h3 className="label text-warn">Pending reminders · {pending.length}</h3>
          <ul className="flex flex-col gap-3">
            {pending.map((o) => (
              <PendingReminder key={o.id} occurrence={o} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Apply any damage or corrections separately, then record the outcome. Acknowledged
            reminders stay here until resolved.
          </p>
        </section>
      )}
      <details>
        <summary className="label min-h-11 py-3">Scheduled reminders · {scheduled.length}</summary>
        <ul className="mt-3 flex flex-col gap-3">
          {scheduled.map((r) => {
            const problem =
              r.trigger.kind === 'turn' ? anchorProblem(snap, r.trigger.anchorCombatantId) : null;
            const effect = snap.timing.effects.find((e) => e.id === r.effectId);
            const review = r.trigger.kind === 'turn' && effect ? effectReview(snap, effect) : [];
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3"
              >
                <div>
                  <p className="text-sm">{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {triggerDescription(snap, r.trigger)} · {r.repeat ? 'Repeats' : 'Once'}
                    {effect && ` · ${effect.name}`}
                  </p>
                  {(problem || review.length > 0) && (
                    <p className="text-xs text-warn">
                      Review required: {[problem, ...review].filter(Boolean).join('; ')}. Disable
                      and recreate to change its anchor.
                    </p>
                  )}
                </div>
                {!completed && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    aria-label={`Disable reminder: ${r.name}`}
                    onClick={() => setDisabling(r.id)}
                  >
                    Disable
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </details>
      {resolved.length > 0 && (
        <details>
          <summary className="label min-h-11 py-3">
            Resolved reminder history · {resolved.length}
          </summary>
          <ul className="mt-3 max-h-60 overflow-y-auto text-xs">
            {[...resolved].reverse().map((o) => (
              <li key={o.id} className="border-t border-border py-2">
                {o.name} · round {o.round} · {name(o.targetCombatantId)} · {o.outcome}
              </li>
            ))}
          </ul>
        </details>
      )}
      {addingReminder && <ReminderEditor close={() => setAddingReminder(false)} />}
      {unlinked.length > 0 && (
        <details>
          <summary className="label min-h-11 py-3">
            Older saved durations without conditions · {unlinked.length}
          </summary>
          <p className="text-xs text-muted-foreground">
            These were created before durations became part of Conditions. Their timing is
            preserved; remove them here if no longer needed.
          </p>
          <ul>
            {unlinked.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{e.name}</span>
                {!completed && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Remove saved duration: ${e.name}`}
                    onClick={() => setEnding(e.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Confirm
        open={!!ending}
        onOpenChange={(open) => !open && setEnding(null)}
        title={`Remove ${unlinked.find((e) => e.id === ending)?.name}?`}
        confirmLabel="Remove duration"
        onConfirm={() => send({ type: 'END_EFFECT', effectId: ending! })}
      >
        <p>Its future reminders stop. Already-triggered reminders stay for manual resolution.</p>
        <SaveError />
      </Confirm>
      <Confirm
        open={!!disabling}
        onOpenChange={(open) => !open && setDisabling(null)}
        title="Disable reminder?"
        confirmLabel="Disable reminder"
        onConfirm={() => send({ type: 'DISABLE_REMINDER', reminderId: disabling! })}
      >
        <p>
          This stops future occurrences and resolves its pending reminders as disabled. Completed
          history remains.
        </p>
        <SaveError />
      </Confirm>
    </section>
  );
}

function PendingReminder({ occurrence: o }: { occurrence: ReminderOccurrence }) {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const select = useStore((s) => s.select);
  const busy = useStore((s) => s.save === 'saving');
  const completed = snap.status === 'completed';
  const name = (id: string | null) =>
    snap.combatants.find((c) => c.id === id)?.name ?? 'No creature source';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {o.name} <Badge tone="amber">{o.status}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          Round {o.round} · {o.triggerKind.toLowerCase().replaceAll('_', ' ')}
          {o.targetCombatantId && ` · ${name(o.targetCombatantId)}`}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-warn">{o.notes}</p>
        {o.effectId && !snap.timing.effects.some((e) => e.id === o.effectId) && (
          <p className="text-xs text-muted-foreground">
            Condition removed; this reminder was already triggered and still needs a manual outcome.
          </p>
        )}
        {o.targetCombatantId && (
          <button
            className="min-h-11 cursor-pointer text-xs hover:text-primary"
            onClick={() => select(o.targetCombatantId)}
          >
            Open {name(o.targetCombatantId)} details
          </button>
        )}
      </div>
      {!completed && (
        <div className="flex flex-wrap gap-2">
          {o.status === 'pending' && (
            <Button
              variant="outline"
              disabled={busy}
              aria-label={`Acknowledge ${o.name}, boundary ${o.boundaryId}`}
              onClick={() => void send({ type: 'ACKNOWLEDGE_REMINDER', occurrenceId: o.id })}
            >
              Acknowledge
            </Button>
          )}
          {(o.kind === 'saving-throw'
            ? (['success', 'failure'] as const)
            : (['done'] as const)
          ).map((outcome) => (
            <Button
              key={outcome}
              variant="outline"
              disabled={busy}
              aria-label={`${outcome}: ${o.name}, boundary ${o.boundaryId}`}
              onClick={() => void send({ type: 'RESOLVE_REMINDER', occurrenceId: o.id, outcome })}
            >
              {outcome === 'done' ? 'Done' : outcome === 'success' ? 'Success' : 'Failure'}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
