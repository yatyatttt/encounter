// Add combatant(s): from a library template (with quantity) or ad hoc. In a running encounter initiative and join policy are required.
import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useStore } from '@/store';
import { initiativeInput } from '@/helpers';
import type { AddEntry, JoinPolicy, Template } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { CombatantForm, emptyForm, formToInput, type FormState } from '@/components/CombatantForm';
import { SaveError } from '@/components/Save';
import { cn } from '@/lib/utils';

export function AddCombatant({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const fieldErrors = useStore((s) => s.fieldErrors);
  const live = snap.status === 'active' || snap.status === 'paused';

  const [source, setSource] = useState<'library' | 'adhoc'>('library');
  const [q, setQ] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [picked, setPicked] = useState<Template | null>(null);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [form, setForm] = useState<FormState>(emptyForm());
  const [mode, setMode] = useState<'total' | 'roll'>('total');
  const [init, setInit] = useState('');
  const [join, setJoin] = useState<JoinPolicy>('next-round');
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = setTimeout(() => {
      api.templates({ q: q.trim() || undefined })
        .then((templates) => { if (current) { setTemplates(templates); setLoadError(undefined); } })
        .catch((error: Error) => { if (current) setLoadError(error.message); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [open, q]);

  const modifier = source === 'library' ? picked?.initiativeModifier : Number(form.initiativeModifier) || 0;
  const initiative = initiativeInput(mode, init);
  const qty = Number(quantity);
  const ready = (source === 'library' ? !!picked : form.name.trim() !== '') && Number.isInteger(qty) && qty >= 1 && (!live || !!initiative);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const entry = {
      ...(source === 'library' ? { templateId: picked!.id } : { adhoc: formToInput(form, false) }),
      ...(source === 'library' && name.trim() ? { name: name.trim() } : {}),
      quantity: qty,
      ...(initiative ? { initiative } : {}),
    } as AddEntry;
    const label = source === 'library' ? (name.trim() || picked!.name) : form.name;
    if (await send({ type: 'ADD_COMBATANTS', entries: [entry], joinPolicy: join })) {
      useStore.getState().announce(`Added ${qty > 1 ? `${qty} × ` : ''}${label}.`);
      setInit(''); setQuantity('1'); setName(picked?.name ?? '');
      if (live) setPicked(null);
      if (live) onOpenChange(false);
      else setMessage(`Added ${qty > 1 ? `${qty} × ` : ''}${label}.`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add combatant" className="max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Segmented label="Source" value={source} onChange={setSource} options={[{ value: 'library', label: 'Library template' }, { value: 'adhoc', label: 'Ad hoc' }]} />
          {source === 'library' ? (
            <div className="flex flex-col gap-2">
              <Field label="Search library">{(id) => <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or tag" />}</Field>
              {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
              {!loadError && templates.length === 0 && (
                <p className="text-sm text-muted-foreground">No templates found. <a href="#/library" className="text-primary underline">Create a template in the Library</a> or use Ad hoc.</p>
              )}
              <ul className="max-h-56 overflow-y-auto border border-border" aria-label="Library templates">
                {templates.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button" aria-pressed={picked?.id === t.id} onClick={() => { setPicked(t); setName(t.name); }}
                      className={cn('flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 border-b border-border px-3 py-1 text-left text-sm last:border-b-0 hover:bg-accent', picked?.id === t.id && 'bg-primary/15 text-primary')}
                    >
                      <span>{picked?.id === t.id ? '● ' : '○ '}{t.name}</span>
                      <span className="text-xs text-muted-foreground">{t.kind} · HP {t.maxHp} · AC {t.armorClass} · init {t.initiativeModifier >= 0 ? '+' : ''}{t.initiativeModifier}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <CombatantForm form={form} setForm={setForm} errors={fieldErrors} />
          )}
          {source === 'library' && picked && (
            <Field label="Name (shown on the roster; numbered if quantity is more than 1)">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
          )}
          <Field label="Quantity (each gets its own HP and numbered name)" className="w-40">
            {(id) => <Input id={id} type="number" min={1} max={200} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </Field>

          {live && (
            <fieldset className="flex flex-col gap-3 border border-border p-3">
              <legend className="label px-1">Initiative (required)</legend>
              <div className="flex flex-wrap items-end gap-3">
                <Segmented label="Entry" value={mode} onChange={setMode} options={[{ value: 'total', label: 'Total' }, { value: 'roll', label: 'Roll' }]} />
                <Field label={mode === 'total' ? 'Initiative total (modifier not added)' : 'd20 roll (1–20)'} className="w-56">
                  {(id) => <Input id={id} type="number" value={init} onChange={(e) => setInit(e.target.value)} />}
                </Field>
                {mode === 'roll' && initiative?.mode === 'roll' && modifier !== undefined && (
                  <p className="pb-3 text-sm">{initiative.roll} {modifier >= 0 ? '+' : '−'} {Math.abs(modifier)} = <strong>{initiative.roll + modifier}</strong></p>
                )}
              </div>
              <Segmented label="Joins combat" value={join} onChange={setJoin} options={[{ value: 'next-round', label: 'Next round' }, { value: 'current-round', label: 'Remaining current round' }]} />
              <p className="text-xs text-muted-foreground">{join === 'next-round' ? 'Takes its first turn when the next round starts.' : 'Gets a turn this round, inserted by initiative among those still to act (never before the active turn).'}</p>
            </fieldset>
          )}
          {message && <p role="status" className="text-sm text-primary">{message}</p>}
          <SaveError />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{live ? 'Cancel' : 'Done'}</Button>
            <Button type="submit" disabled={!ready || busy}>Add{qty > 1 ? ` ×${qty}` : ''}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
