import { useState } from 'react';
import { useStore } from '@/store';
import { CONDITION_KEYS, EncounterCommand, type ConditionDto, type ConditionKey, type EffectDuration } from '../../shared/contract';
import { effectReview } from '../../domain/timing';
import { conditionDuration, durationDescription } from '@/timing';
import { cap } from '@/helpers';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { SaveError } from '@/components/Save';

export function ConditionEditor({ combatantId, application, close }: { combatantId: string; application: ConditionDto | null; close: () => void }) {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const [key, setKey] = useState<ConditionKey>(application?.conditionKey ?? 'poisoned');
  const [source, setSource] = useState(application?.sourceLabel ?? '');
  const [sourceCreature, setSourceCreature] = useState(application?.sourceCombatantId ?? '');
  const [notes, setNotes] = useState(application?.notes ?? '');
  const [duration, setDuration] = useState<EffectDuration>(application ? conditionDuration(snap, application) : { kind: 'manual' });
  const caster = duration.kind === 'concentration' ? snap.concentrations.find((c) => c.id === duration.concentrationId)?.combatantId : undefined;
  const sourceId = duration.kind === 'concentration' ? caster ?? null : sourceCreature || null;
  const command: EncounterCommand = application
    ? { type: 'UPDATE_CONDITION', applicationId: application.id, sourceCombatantId: sourceId, sourceLabel: source, notes, duration }
    : { type: 'ADD_CONDITION', combatantId, conditionKey: key, sourceCombatantId: sourceId ?? undefined, sourceLabel: source, notes, duration };
  const valid = EncounterCommand.safeParse(command).success && (duration.kind !== 'concentration' || !!caster);
  const review = effectReview(snap, { sourceCombatantId: sourceId, targetCombatantIds: [combatantId], duration });
  const setKind = (kind: EffectDuration['kind']) => {
    switch (kind) {
      case 'next-turn': setDuration({ kind, anchorCombatantId: combatantId, phase: 'end' }); break;
      case 'rounds': setDuration({ kind, count: 1, anchorCombatantId: null, phase: 'start' }); break;
      case 'concentration': setDuration({ kind, concentrationId: snap.concentrations[0]?.id ?? '' }); break;
      case 'save-ends': setDuration({ kind, phase: 'end', ability: 'constitution', dc: null }); break;
      default: setDuration({ kind });
    }
  };
  return <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent title={application ? `Edit ${cap(key)}` : 'Add condition'} description={`Condition on ${snap.combatants.find((c) => c.id === combatantId)?.name}. Each source has its own duration and can be removed manually.`}>
      <form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); if (valid && await send(command)) close(); }}>
        {!application && <Field label="Condition">{(id) => <Select id={id} value={key} onChange={(e) => setKey(e.target.value as ConditionKey)}>{CONDITION_KEYS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}</Select>}</Field>}
        <Field label="Source">{(id) => <Input id={id} value={source} maxLength={200} placeholder="e.g. Ghoul claw" onChange={(e) => setSource(e.target.value)} />}</Field>
        <Field label="Source creature (optional)">{(id) => <Select id={id} value={sourceId ?? ''} disabled={duration.kind === 'concentration'} onChange={(e) => setSourceCreature(e.target.value)}><option value="">No creature source</option>{snap.combatants.map((c) => <option key={c.id} value={c.id}>{c.name}{c.removedAt !== null && ' · removed'}</option>)}</Select>}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <Field label="Duration">{(id) => <Select id={id} value={duration.kind} onChange={(e) => setKind(e.target.value as EffectDuration['kind'])}><option value="manual">Until removed manually</option><option value="next-turn">Start/end of next creature turn</option><option value="rounds">Fixed rounds</option><option value="concentration" disabled={!snap.concentrations.length}>Concentration</option><option value="save-ends">Save ends</option><option value="encounter-end">Encounter end</option></Select>}</Field>
        {(duration.kind === 'next-turn' || duration.kind === 'rounds') && <>
          <Field label="Duration anchor">{(id) => <Select id={id} value={duration.anchorCombatantId ?? ''} onChange={(e) => setDuration(duration.kind === 'rounds' ? { ...duration, anchorCombatantId: e.target.value || null } : { ...duration, anchorCombatantId: e.target.value })}>{duration.kind === 'rounds' && <option value="">Whole round</option>}{snap.combatants.map((c) => <option key={c.id} value={c.id}>{c.name}{c.removedAt !== null && ' · removed'}</option>)}</Select>}</Field>
          <Field label="Expiry boundary">{(id) => <Select id={id} value={duration.phase} onChange={(e) => setDuration({ ...duration, phase: e.target.value as 'start' | 'end' })}><option value="start">Start</option><option value="end">End</option></Select>}</Field>
          {duration.kind === 'rounds' && <Field label="Number of rounds">{(id) => <Input id={id} type="number" min={1} max={1000} required value={duration.count} onChange={(e) => setDuration({ ...duration, count: Number(e.target.value) })} />}</Field>}
        </>}
        {duration.kind === 'concentration' && <Field label="Concentration">{(id) => <Select id={id} value={duration.concentrationId} onChange={(e) => setDuration({ ...duration, concentrationId: e.target.value })}>{snap.concentrations.map((c) => <option key={c.id} value={c.id}>{snap.combatants.find((x) => x.id === c.combatantId)?.name} · {c.name}</option>)}</Select>}</Field>}
        {duration.kind === 'concentration' && !caster && <p role="status" className="text-xs text-warn">The selected concentration ended. Choose another concentration or duration.</p>}
        {duration.kind === 'save-ends' && <>
          <Field label="Save boundary">{(id) => <Select id={id} value={duration.phase} onChange={(e) => setDuration({ ...duration, phase: e.target.value as 'start' | 'end' })}><option value="start">Target turn start</option><option value="end">Target turn end</option></Select>}</Field>
          <Field label="Saving throw ability">{(id) => <Select id={id} value={duration.ability} onChange={(e) => setDuration({ ...duration, ability: e.target.value as typeof duration.ability })}>{['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'].map((a) => <option key={a} value={a}>{cap(a)}</option>)}</Select>}</Field>
          <Field label="Save DC (optional)">{(id) => <Input id={id} type="number" min={1} max={1000} value={duration.dc ?? ''} onChange={(e) => setDuration({ ...duration, dc: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>
        </>}
        <p className="border-l-2 border-warn pl-3 text-sm text-warn" role="status">Duration preview: {durationDescription(snap, duration)}.</p>
        {review.map((problem) => <p key={problem} className="text-xs text-warn">Review required: {problem}. Creature timers wait; whole-round timers can continue.</p>)}
        {application && <p className="text-xs text-muted-foreground">Saving restarts this source's duration from now. Other condition sources keep their durations.</p>}
        <SaveError />
        <DialogFooter><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !valid}>{application ? 'Save condition' : `Add ${cap(key)}`}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
