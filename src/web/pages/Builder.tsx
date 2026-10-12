import { useState } from 'react';
import { useStore, useDraft } from '@/store';
import { initiativeInput } from '@/helpers';
import type { CombatantDto } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Confirm } from '@/components/ui/dialog';
import { SaveStatus } from '@/components/Save';
import { Detail } from '@/components/Detail';
import { AddCombatant } from '@/components/AddCombatant';
import { DuplicateButton } from '@/components/Duplicate';
import { cn } from '@/lib/utils';
import { ConcentrationChecks, ConcentrationRemoval } from '@/components/Concentration';
import { RemindersManager, ParticipationConditionsNotice } from '@/components/Reminders';

export function Builder() {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const drafts = useStore((s) => s.drafts);
  const setDraft = useStore((s) => s.setDraft);

  const [name, setName] = useDraft('meta:name', snap.name);
  const [notes, setNotes] = useDraft('meta:notes', snap.notes);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'total' | 'roll'>('total');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [shared, setShared] = useDraft('shared-initiative');
  const [removing, setRemoving] = useState<CombatantDto | null>(null);
  const [concentrationPolicy, setConcentrationPolicy] = useState<'keep' | 'end'>('keep');
  const [initError, setInitError] = useState<string>();

  const rows = snap.combatants.filter((c) => c.removedAt === null);
  const metaDirty = name !== snap.name || notes !== snap.notes;

  // tie groups: rows (already in display order) sharing one initiative total
  const groups = new Map<number, string[]>();
  for (const c of rows) if (c.initiativeTotal !== null) groups.set(c.initiativeTotal, [...(groups.get(c.initiativeTotal) ?? []), c.id]);
  const moveTie = (c: CombatantDto, dir: -1 | 1) => {
    const ids = [...groups.get(c.initiativeTotal!)!];
    const i = ids.indexOf(c.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    void send({ type: 'SET_TIE_ORDER', combatantIds: ids });
  };

  const stored = (c: CombatantDto) =>
    mode === 'roll' ? (c.initiativeMode === 'roll' && c.initiativeRoll !== null ? String(c.initiativeRoll) : '') : c.initiativeTotal === null ? '' : String(c.initiativeTotal);
  const typed = rows.filter((c) => drafts[`init:${c.id}`] !== undefined && drafts[`init:${c.id}`].trim() !== '');

  const applyInitiative = async () => {
    const entries = [];
    for (const c of typed) {
      const input = initiativeInput(mode, drafts[`init:${c.id}`]);
      if (!input) { setInitError(`${c.name}: enter a whole number${mode === 'roll' ? ' from 1 to 20 (d20 roll)' : ''}.`); return; }
      entries.push({ combatantId: c.id, ...input });
    }
    setInitError(undefined);
    if (entries.length && (await send({ type: 'SET_INITIATIVE', entries }))) typed.forEach((c) => setDraft(`init:${c.id}`, null));
  };

  const sharedInput = initiativeInput('total', shared);
  const applyShared = async () => {
    if (!sharedInput || sharedInput.mode !== 'total') return;
    const entries = [...checked].map((combatantId) => ({ combatantId, mode: 'total' as const, total: sharedInput.total }));
    if (await send({ type: 'SET_INITIATIVE', entries })) { setChecked(new Set()); setShared(null); }
  };

  const unscheduled = rows.filter((c) => c.initiativeTotal === null).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label">Encounter builder · draft</p>
          <h1 className="text-xl">{snap.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveStatus />
          <DuplicateButton />
          <Button size="lg" disabled={busy || rows.length === 0} onClick={() => void send({ type: 'START_COMBAT' })}>Start Combat</Button>
        </div>
      </div>

      <ConcentrationChecks />
      <RemindersManager />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-label="Encounter details" className="grid gap-3 border border-border bg-card p-4 md:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Notes / objectives" className="md:row-span-2">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className="h-full" />}</Field>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-5 accent-[#3fcf8e]" checked={snap.skipZeroHpEnemies} disabled={busy}
                  onChange={(e) => void send({ type: 'UPDATE_METADATA', skipZeroHpEnemies: e.target.checked })} />
                Skip zero-HP enemies when scheduling turns
              </label>
              <div>
                <Button variant="outline" disabled={!metaDirty || busy || !name.trim()} onClick={async () => {
                  if (await send({ type: 'UPDATE_METADATA', name, notes })) { setName(null); setNotes(null); }
                }}>Save details</Button>
              </div>
            </div>
          </section>

          <section aria-label="Roster" className="flex flex-col gap-3 border border-border bg-card p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="label">Roster · {rows.length}</h2>
              <Button onClick={() => setAdding(true)}>+ Add combatant</Button>
            </div>

            {rows.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                <p className="mb-3">No combatants yet.</p>
                <Button onClick={() => setAdding(true)}>Add a combatant</Button>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-4 border border-border p-3">
                  <Segmented label="Initiative entry mode" value={mode} onChange={setMode} options={[{ value: 'total', label: 'Total' }, { value: 'roll', label: 'Roll' }]} />
                  <p className="max-w-64 pb-3 text-xs text-muted-foreground">{mode === 'total' ? 'TOTAL: stored exactly as typed. The modifier is NOT added again.' : 'ROLL: d20 result 1–20. Total = roll + modifier.'}</p>
                  <Button disabled={typed.length === 0 || busy} onClick={() => void applyInitiative()}>Apply initiative ({typed.length})</Button>
                  <div className="ml-auto flex items-end gap-2">
                    <Field label={`Shared total for ${checked.size} selected`} className="w-44">
                      {(id) => <Input id={id} type="number" value={shared} onChange={(e) => setShared(e.target.value)} />}
                    </Field>
                    <Button variant="outline" disabled={!sharedInput || checked.size === 0 || busy} onClick={() => void applyShared()}>Set shared</Button>
                  </div>
                </div>
                {initError && <p role="alert" className="text-sm text-warn">{initError}</p>}
                {unscheduled > 0 && <p className="text-sm text-warn">{unscheduled} combatant{unscheduled > 1 ? 's have' : ' has'} no initiative and will not be scheduled. Enter initiative below.</p>}

                <div className="overflow-x-auto">
                  <table>
                    <caption className="sr-only">Encounter roster and initiative setup</caption>
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th scope="col" className="w-11 p-2"><span className="sr-only">Select for shared initiative</span></th>
                        {['Init', mode === 'roll' ? 'Enter roll' : 'Enter total', 'Name', 'HP / Max', 'Temp', 'AC', 'Mod', 'Tie order'].map((h) => <th key={h} scope="col" className="label p-2 font-medium">{h}</th>)}
                        <th scope="col" className="p-2"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => {
                        const group = c.initiativeTotal !== null ? groups.get(c.initiativeTotal)! : [];
                        const gi = group.indexOf(c.id);
                        const draftText = drafts[`init:${c.id}`];
                        const value = draftText ?? stored(c);
                        const rollN = Number(value);
                        const isSel = selectedId === c.id;
                        return (
                          <tr key={c.id} className={cn('border-b border-border last:border-b-0', isSel && 'bg-accent')}>
                            <td className="p-2">
                              <input type="checkbox" className="size-5 accent-[#3fcf8e]" aria-label={`Select ${c.name} for shared initiative`} checked={checked.has(c.id)}
                                onChange={(e) => setChecked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                            </td>
                            <td className="p-2 text-base">{c.initiativeTotal ?? <span className="text-muted-foreground">—</span>}{c.initiativeMode === 'roll' && c.initiativeRoll !== null && <span className="block text-[0.65rem] text-muted-foreground">roll {c.initiativeRoll}</span>}</td>
                            <td className="p-2">
                              <Input className="w-24" type="number" aria-label={`Initiative ${mode} for ${c.name}`} value={value}
                                onChange={(e) => setDraft(`init:${c.id}`, e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void applyInitiative(); if (e.key === 'Escape') setDraft(`init:${c.id}`, null); }} />
                              {mode === 'roll' && draftText && Number.isInteger(rollN) && <span className="block text-[0.65rem]">{rollN}{c.initiativeModifier >= 0 ? '+' : '−'}{Math.abs(c.initiativeModifier)} = {rollN + c.initiativeModifier}</span>}
                            </td>
                            <td className="p-2">
                              <button type="button" aria-pressed={isSel} onClick={() => select(c.id)}
                                className={cn('min-h-11 cursor-pointer text-left hover:text-primary', isSel && 'text-primary')}>
                                {isSel ? '> ' : ''}{c.name}{isSel && <span className="label ml-2 text-primary">Selected</span>}
                                {c.exhaustionLevel > 0 && <Badge tone="amber" className="ml-2">Exh {c.exhaustionLevel}</Badge>}
                              </button>
                            </td>
                            <td className="p-2">{c.currentHp} / {c.maxHp}</td>
                            <td className={cn('p-2', c.tempHp > 0 && 'text-warn')}>{c.tempHp}</td>
                            <td className="p-2">{c.armorClass}</td>
                            <td className="p-2">{c.initiativeModifier >= 0 ? '+' : ''}{c.initiativeModifier}</td>
                            <td className="whitespace-nowrap p-2">
                              {group.length > 1 ? (
                                <span className="inline-flex items-center gap-1">
                                  <Button size="sm" variant="outline" disabled={gi === 0 || busy} aria-label={`Move ${c.name} up within tie at ${c.initiativeTotal}`} onClick={() => moveTie(c, -1)}>▲</Button>
                                  <Button size="sm" variant="outline" disabled={gi === group.length - 1 || busy} aria-label={`Move ${c.name} down within tie at ${c.initiativeTotal}`} onClick={() => moveTie(c, 1)}>▼</Button>
                                  <span className="text-xs text-warn">tie ×{group.length}</span>
                                </span>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="p-2 text-right"><Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}>Remove</Button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
        <Detail draft />
      </div>

      <AddCombatant open={adding} onOpenChange={setAdding} />
      <Confirm open={!!removing} onOpenChange={(o) => { if (!o) { setRemoving(null); setConcentrationPolicy('keep'); } }} title={`Remove ${removing?.name}?`} confirmLabel="Remove" onConfirm={() => send({ type: 'REMOVE_COMBATANT', combatantId: removing!.id, concentrationPolicy })}>
        Remove <strong>{removing?.name}</strong> from this encounter draft?
        {removing && <ConcentrationRemoval combatantId={removing.id} value={concentrationPolicy} onChange={setConcentrationPolicy} />}
        {removing && <ParticipationConditionsNotice combatantId={removing.id} />}
      </Confirm>
    </div>
  );
}
