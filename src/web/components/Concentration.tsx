import { useState } from 'react';
import { useDraft, useStore } from '@/store';
import { isIncapacitated } from '../../domain/concentration';
import type { CombatantDto } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Confirm } from '@/components/ui/dialog';
import { SaveError } from '@/components/Save';
import { cap } from '@/helpers';

export function ConcentrationPanel({ c, locked }: { c: CombatantDto; locked: boolean }) {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const [name, setName] = useDraft(`concentration:${c.id}`);
  const [replacing, setReplacing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState<'manual' | 'death'>('manual');
  const conc = snap.concentrations.find((k) => k.combatantId === c.id);
  const incapacitated = isIncapacitated(snap.conditions, c.id);
  const completed = snap.status === 'completed';
  const linkedIds = new Set(conc ? [...conc.linkedEffects.map((e) => e.id), ...snap.timing.effects.filter((e) => e.duration.kind === 'concentration' && e.duration.concentrationId === conc.id).map((e) => e.id)] : []);
  const applications = snap.conditions.filter((k) => k.effectId && linkedIds.has(k.effectId));
  const begin = async (replace: boolean) => {
    const ok = await send({ type: 'START_CONCENTRATION', combatantId: c.id, name, replace });
    if (ok) setName(null);
    return ok;
  };

  return (
    <section aria-label={`Concentration: ${c.name}`} className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="label">Concentration</h3>
      {conc ? (
        <>
          <Badge tone="amber">Concentrating: {conc.name}</Badge>
          <p className="text-xs text-muted-foreground">Started in round {conc.startBoundary.round}{conc.startBoundary.activeCombatantId && ` · ${snap.combatants.find((x) => x.id === conc.startBoundary.activeCombatantId)?.name}'s turn`}. {conc.checks.length} pending check{conc.checks.length !== 1 && 's'}.</p>
          {c.removedAt !== null && <p className="text-xs text-warn">Caster removed; concentration was kept and can still be ended here.</p>}
          <ul className="flex flex-col gap-1 text-xs">
            {applications.map((a) => <li key={a.id}><span className="text-warn">{cap(a.conditionKey)}</span> on {snap.combatants.find((x) => x.id === a.targetCombatantId)?.name}{a.sourceLabel && ` · ${a.sourceLabel}`}</li>)}
          </ul>
          {!completed && <p className="text-xs text-muted-foreground">To link a condition, select its target and choose Concentration as the condition's duration.</p>}
          {!completed && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => { setReason('manual'); setEnding(true); }}>End concentration</Button>
            </>
          )}
        </>
      ) : <p className="text-sm text-muted-foreground">Not concentrating.</p>}
      {!locked && (
        <form onSubmit={(e) => { e.preventDefault(); if (conc) setReplacing(true); else void begin(false); }} className="flex flex-col gap-2">
          <Field label={conc ? 'New concentration effect' : 'Concentration effect'}>{(id) => <Input id={id} placeholder="e.g. Bless" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} disabled={busy || incapacitated} />}</Field>
          {incapacitated && <p className="text-xs text-warn">An Incapacitated creature cannot concentrate, including when Paralyzed, Petrified, Stunned, or Unconscious.</p>}
          <Button type="submit" disabled={busy || incapacitated || !name.trim()}>{conc ? 'Replace concentration…' : 'Begin concentration'}</Button>
        </form>
      )}
      <p className="text-xs text-muted-foreground">Positive damage prompts a Constitution save, even when temp HP absorbs it. HP corrections and healing do not. At 0 HP, the DM decides whether death or Unconscious applies.</p>
      <Confirm open={replacing} onOpenChange={setReplacing} title={`Replace ${conc?.name}?`} confirmLabel="Replace concentration" onConfirm={() => begin(true)}>
        Begin <strong>{name}</strong> for {c.name}? This ends {conc?.name}, all its linked effects and pending checks. Independent condition sources and temp HP stay.
        <SaveError />
      </Confirm>
      <Confirm open={ending && !!conc} onOpenChange={setEnding} title={`End ${conc?.name}?`} confirmLabel={reason === 'death' ? 'Confirm death & end concentration' : 'End concentration'} onConfirm={() => send({ type: 'END_CONCENTRATION', concentrationId: conc!.id, reason })}>
        <p>End {c.name}'s <strong>{conc?.name}</strong>? All its linked condition applications and pending checks are removed. Other sources and temp HP stay.</p>
        <Field label="Reason">{(id) => <Select id={id} value={reason} onChange={(e) => setReason(e.target.value as 'manual' | 'death')}><option value="manual">Manual end</option><option value="death">Confirmed death (DM adjudicated)</option></Select>}</Field>
        {reason === 'death' && <p className="text-xs text-warn">This ends concentration only. Exclude or remove {c.name} from turns separately.</p>}
        <SaveError />
      </Confirm>
    </section>
  );
}

export function ConcentrationChecks() {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const select = useStore((s) => s.select);
  const busy = useStore((s) => s.save === 'saving');
  const pending = snap.concentrations.flatMap((conc) => conc.checks.map((check) => ({ conc, check })));
  const kept = snap.concentrations.filter((conc) => snap.combatants.find((c) => c.id === conc.combatantId)?.removedAt !== null);
  if (!pending.length && !kept.length) return null;
  return (
    <section aria-label="Concentration checks" className="flex flex-col gap-3 border border-warn bg-card p-4">
      <h2 className="label text-warn" role="status">Concentration checks · {pending.length}</h2>
      {kept.map((conc) => <button key={conc.id} className="min-h-11 cursor-pointer text-left text-sm text-warn" onClick={() => select(conc.combatantId)}>{snap.combatants.find((c) => c.id === conc.combatantId)?.name} · {conc.name} · caster removed, concentration kept — manage</button>)}
      <p className="text-xs text-muted-foreground">Record each Constitution save separately. Failure ends that concentration and all its linked effects.</p>
      <ul className="flex flex-col gap-2">
        {pending.map(({ conc, check }, i) => {
          const caster = snap.combatants.find((c) => c.id === conc.combatantId)!;
          return (
            <li key={check.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2">
              <div><button className="min-h-11 cursor-pointer text-left text-sm hover:text-primary" onClick={() => select(caster.id)}>{caster.name} · {conc.name}{caster.removedAt !== null && ' · removed'}</button><p className="text-xs text-warn">Check {i + 1}: {check.damage} damage → DC {check.dc} Constitution save</p></div>
              {snap.status !== 'completed' && <div className="flex gap-2">{(['success', 'failure'] as const).map((outcome) => <Button key={outcome} variant="outline" disabled={busy} aria-label={`${outcome === 'success' ? 'Success' : 'Failure'}: ${caster.name} check ${i + 1}, DC ${check.dc}`} onClick={() => void send({ type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: conc.id, checkId: check.id, outcome })}>{outcome === 'success' ? 'Success' : 'Failure'}</Button>)}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ConcentrationRemoval({ combatantId, value, onChange }: { combatantId: string; value: 'keep' | 'end'; onChange: (value: 'keep' | 'end') => void }) {
  const conc = useStore((s) => s.snapshot!.concentrations.find((c) => c.combatantId === combatantId));
  if (!conc) return null;
  return <Field label={`Concentration on ${conc.name}`}>
    {(id) => <Select id={id} value={value} onChange={(e) => onChange(e.target.value as 'keep' | 'end')}><option value="keep">Keep concentration and its linked effects</option><option value="end">End concentration and its linked effects</option></Select>}
  </Field>;
}
