import { useState } from 'react';
import { useStore } from '@/store';
import { ReminderInput, type ReminderTrigger } from '../../shared/contract';
import { triggerDescription } from '@/timing';
import { anchorProblem } from '../../domain/timing';
import { cap } from '@/helpers';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { SaveError } from '@/components/Save';

export function ReminderEditor({ close }: { close: () => void }) {
  const snap = useStore((s) => s.snapshot)!;
  const selectedId = useStore((s) => s.selectedId);
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [kind, setKind] = useState<ReminderInput['kind']>('note');
  const [trigger, setTrigger] = useState<ReminderTrigger>({ kind: 'turn', anchorCombatantId: selectedId ?? snap.combatants[0]?.id ?? '', phase: 'start' });
  const [repeat, setRepeat] = useState(true);
  const [effectId, setEffectId] = useState('');
  const input: ReminderInput = { name, notes, kind, trigger, repeat, effectId: effectId || null };
  const valid = ReminderInput.safeParse(input).success;
  const problem = trigger.kind === 'turn' ? anchorProblem(snap, trigger.anchorCombatantId) : null;
  return <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent title="Add reminder" description="A reminder prompts the DM. It never rolls dice, applies damage, or assumes a successful save.">
      <form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); if (valid && await send({ type: 'CREATE_REMINDER', reminder: input })) close(); }}>
        <Field label="Reminder name">{(id) => <Input id={id} value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Reminder type">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="note">Custom note</option><option value="saving-throw">Saving throw</option><option value="damage">Ongoing damage</option><option value="feature">Class feature / recharge reminder</option></Select>}</Field>
        <Field label="Reminder instructions">{(id) => <Textarea id={id} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Roll 1d6 fire damage and apply it manually" />}</Field>
        <Field label="Reminder anchor type">{(id) => <Select id={id} value={trigger.kind} onChange={(e) => setTrigger(e.target.value === 'round' ? { kind: 'round', phase: trigger.phase } : { kind: 'turn', phase: trigger.phase, anchorCombatantId: selectedId ?? snap.combatants[0]?.id ?? '' })}><option value="turn">Creature turn</option><option value="round">Whole round</option></Select>}</Field>
        {trigger.kind === 'turn' && <Field label="Reminder anchor">{(id) => <Select id={id} value={trigger.anchorCombatantId} onChange={(e) => setTrigger({ ...trigger, anchorCombatantId: e.target.value })}>{snap.combatants.map((c) => <option key={c.id} value={c.id}>{c.name}{c.removedAt !== null && ' · removed'}</option>)}</Select>}</Field>}
        <Field label="Reminder boundary">{(id) => <Select id={id} value={trigger.phase} onChange={(e) => setTrigger({ ...trigger, phase: e.target.value as 'start' | 'end' })}><option value="start">Start</option><option value="end">End</option></Select>}</Field>
        <Field label="Associated condition (optional)">{(id) => <Select id={id} value={effectId} onChange={(e) => setEffectId(e.target.value)}><option value="">Independent reminder</option>{snap.timing.effects.map((e) => {
          const applications = snap.conditions.filter((c) => c.effectId === e.id);
          const label = applications.map((c) => `${cap(c.conditionKey)} · ${snap.combatants.find((x) => x.id === c.targetCombatantId)?.name}${c.sourceLabel ? ` · ${c.sourceLabel}` : ''}`).join(', ');
          return <option key={e.id} value={e.id}>{label || `Older saved duration: ${e.name}`}</option>;
        })}</Select>}</Field>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-primary" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Repeat at every matching boundary</label>
        <p className="text-sm text-warn" role="status">{repeat ? 'Every matching' : 'Next matching'} boundary after saving: {triggerDescription(snap, trigger)}. {effectId && 'Future occurrences stop when the condition is removed; triggered reminders stay for manual resolution.'}</p>
        {problem && <p className="text-xs text-warn">Review required: {problem}. This reminder waits until the anchor participates again.</p>}
        <SaveError />
        <DialogFooter><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !valid}>Create reminder</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
