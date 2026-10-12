// Selected-combatant panel, shared by the builder (draft: edits STARTING values) and tracker (live corrections).
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useStore, useDraft } from '@/store';
import { previewHpInput, conditionBadges, cap, hpBar } from '@/helpers';
import { grantTempHp } from '../../domain/hp';
import { concentrationDc } from '../../domain/concentration';
import { type CombatantDto, type ConditionDto, type ConditionKey, type EncounterCommand, type EditableCombatantPatch, type TurnPolicy } from '../../shared/contract';
import { effectReview } from '../../domain/timing';
import { conditionDurationDescription } from '@/timing';
import { CONDITION_RULES, RULES_VERSION } from '@/rules';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, Field } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Confirm } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ConcentrationPanel, ConcentrationRemoval } from '@/components/Concentration';
import { ParticipationConditionsNotice } from '@/components/Reminders';
import { ConditionEditor } from '@/components/ConditionEditor';

const isInt = (s: string) => s.trim() !== '' && Number.isInteger(Number(s));

export function Detail({ draft }: { draft: boolean }) {
  const snap = useStore((s) => s.snapshot)!;
  const selectedId = useStore((s) => s.selectedId);
  const c = snap.combatants.find((x) => x.id === selectedId);
  if (!c) {
    return <aside className="border border-border bg-card p-4 text-sm text-muted-foreground max-xl:hidden">Select a combatant to {draft ? 'edit its starting stats and conditions' : 'enter HP changes and manage conditions'}.</aside>;
  }
  return <DetailBody key={c.id} c={c} draft={draft} />;
}

function DetailBody({ c, draft }: { c: CombatantDto; draft: boolean }) {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const select = useStore((s) => s.select);
  const busy = useStore((s) => s.save === 'saving');
  const [removing, setRemoving] = useState(false);
  const [concentrationPolicy, setConcentrationPolicy] = useState<'keep' | 'end'>('keep');
  const locked = snap.status === 'completed' || c.removedAt !== null;
  const isActive = snap.activeCombatantId === c.id;
  const conditions = snap.conditions.filter((x) => x.targetCombatantId === c.id);

  return (
    <aside
      aria-label={`Selected: ${c.name}`}
      className="relative flex flex-col gap-5 overflow-y-auto border border-border bg-card p-4 max-xl:fixed max-xl:inset-x-0 max-xl:bottom-0 max-xl:z-30 max-xl:max-h-[70vh] max-xl:border-t-2 max-xl:border-t-primary xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]"
    >
      <button type="button" onClick={() => select(null)} aria-label="Close details" className="absolute right-1 top-1 inline-flex size-11 items-center justify-center text-muted-foreground hover:text-foreground xl:hidden">
        <X className="size-4" />
      </button>
      <header>
        <p className="label text-primary">Selected{isActive && ' · active turn'}{c.removedAt !== null && ' · removed'}</p>
        <h2 className="text-lg">{c.name}</h2>
        <p className="text-sm">
          <span className={cn(c.currentHp === 0 && 'text-destructive')}>{c.currentHp === 0 ? '0 HP' : `${c.currentHp} HP`}</span> / {c.maxHp} <span className="text-primary">{hpBar(c.currentHp, c.maxHp)}</span>
          {c.tempHp > 0 && <span className="text-warn"> · +{c.tempHp} temp</span>} · AC {c.armorClass} · {c.speedFt} ft · <span className="uppercase text-muted-foreground">{c.kind}</span>
        </p>
      </header>

      {!locked && !draft && <HpEntry c={c} />}
      {!locked && !draft && <TempGrant c={c} />}
      {!locked && !draft && (
        <Field label={`Turn policy · ${c.eligible ? 'eligible next round' : 'NOT eligible next round'}`}>
          {(id) => (
            <Select id={id} value={c.turnPolicy} onChange={(e) => void send({ type: 'SET_TURN_POLICY', combatantId: c.id, policy: e.target.value as TurnPolicy })} disabled={busy}>
              <option value="default">Default (follow HP policy)</option>
              <option value="include">Always include</option>
              <option value="exclude">Exclude from turns</option>
            </Select>
          )}
        </Field>
      )}

      {locked ? (
        <p className="text-sm text-muted-foreground">{snap.status === 'completed' ? 'Completed encounters are read-only.' : 'Stats are read-only while removed. Condition durations can still be edited or removed; reinstate to add new conditions or edit stats.'}</p>
      ) : (
        <details open={draft} className="border-t border-border pt-3">
          <summary className="label">{draft ? 'Starting stats' : 'Corrections'}</summary>
          <div className="mt-3 flex flex-col gap-3">
            {draft && <SetValue id={`hp:${c.id}`} label="Starting HP" current={c.currentHp} make={(n) => ({ type: 'SET_HP', combatantId: c.id, value: n })} hint={(n) => (n > c.maxHp ? `Out of range: 0–${c.maxHp}` : null)} />}
            <SetValue
              id={`max:${c.id}`} label="Max HP" current={c.maxHp} min={1}
              make={(n) => ({ type: 'SET_MAX_HP', combatantId: c.id, value: n })}
              hint={(n) => (n < c.currentHp ? `Current HP is clamped ${c.currentHp} → ${n}.` : draft ? null : `Current HP stays ${c.currentHp}.`)}
            />
            <SetValue id={`temp:${c.id}`} label={draft ? 'Starting temp HP' : 'Set temp HP (correction)'} current={c.tempHp} make={(n) => ({ type: 'SET_TEMP_HP', combatantId: c.id, value: n })} />
            <EditFields c={c} />
          </div>
        </details>
      )}

      <ConcentrationPanel c={c} locked={locked} />
      <Conditions c={c} locked={snap.status === 'completed'} conditions={conditions} />

      {!locked && !draft && (
        <div className="border-t border-border pt-3">
          <Button variant="outline" onClick={() => { setConcentrationPolicy('keep'); setRemoving(true); }} disabled={busy}>Remove {c.name}</Button>
        </div>
      )}
      <Confirm
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${c.name}?`}
        confirmLabel="Remove"
        onConfirm={() => send({ type: 'REMOVE_COMBATANT', combatantId: c.id, concentrationPolicy })}
      >
        {isActive && snap.status === 'active'
          ? <p><strong>{c.name} is the ACTIVE combatant.</strong> Removing it ends its turn and advances to the next participant in the same step.</p>
          : isActive
            ? <p>{c.name} is the active combatant. Combat is paused, so removing it clears the active turn; the next participant is chosen when you resume.</p>
            : <p>{c.name} leaves the turn order but is kept as a removed entry, so you can reinstate it later.</p>}
        <ConcentrationRemoval combatantId={c.id} value={concentrationPolicy} onChange={setConcentrationPolicy} />
        <ParticipationConditionsNotice combatantId={c.id} />
      </Confirm>

      <RulesReference />
    </aside>
  );
}

function HpEntry({ c }: { c: CombatantDto }) {
  const [text, setText] = useDraft(`hpentry:${c.id}`);
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const ref = useRef<HTMLInputElement>(null);
  const preview = previewHpInput(c, text);
  const concentrating = useStore((s) => s.snapshot!.concentrations.some((k) => k.combatantId === c.id));
  const checkDc = concentrating && preview?.ok && preview.command.type === 'APPLY_DAMAGE' && preview.command.amount > 0 ? concentrationDc(preview.command.amount) : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preview?.ok) return; // never commit partial / invalid typing
    if (await send(preview.command)) { setText(null); ref.current?.focus(); }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <Field label={`HP entry · ${c.name}`}>
        {(id) => (
          <div className="flex gap-2">
            <Input
              id={id} ref={ref} value={text} autoComplete="off" inputMode="text" placeholder="-12 dmg · +8 heal · 15 set"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setText(null); } }}
            />
            <Button type="submit" disabled={!preview?.ok || busy}>Apply</Button>
          </div>
        )}
      </Field>
      <p className={cn('min-h-5 text-xs', preview && !preview.ok ? 'text-warn' : 'text-foreground')} aria-live="polite">{preview?.label ?? ''}</p>
      {checkDc !== null && <p className="text-xs text-warn" role="status">Concentration: prompts a DC {checkDc} Constitution save.</p>}
    </form>
  );
}

function TempGrant({ c }: { c: CombatantDto }) {
  const [text, setText] = useDraft(`tempgrant:${c.id}`);
  const [choice, setChoice] = useState<'keep' | 'replace'>('replace');
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const amount = Number(text);
  const valid = isInt(text) && amount >= 0;
  const hasPool = c.tempHp > 0;
  const effective = hasPool ? choice : 'replace';
  const cur = { hp: c.currentHp, tempHp: c.tempHp };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && (await send({ type: 'GRANT_TEMP_HP', combatantId: c.id, amount, choice: effective }))) setText(null);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-end gap-2">
        <Field label="Grant temp HP" className="flex-1">
          {(id) => <Input id={id} type="number" min={0} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setText(null)} />}
        </Field>
        <Button type="submit" disabled={!valid || busy}>Grant</Button>
      </div>
      {hasPool && <Segmented label={`Existing pool: ${c.tempHp} (pools never stack)`} value={choice} onChange={setChoice} options={[{ value: 'keep', label: 'Keep' }, { value: 'replace', label: 'Replace' }]} />}
      {valid && (
        <p className="text-xs">
          {hasPool
            ? <>KEEP → {grantTempHp(cur, amount, 'keep').tempHp} temp · REPLACE → {grantTempHp(cur, amount, 'replace').tempHp} temp · <span className="text-warn">{effective.toUpperCase()} selected</span></>
            : <>{c.name}: grant {amount} → {amount} temp HP</>}
        </p>
      )}
    </form>
  );
}

/** One numeric correction with a Set button, Escape to clear, and an optional consequence hint. */
function SetValue({ id, label, current, make, hint, min = 0 }: {
  id: string; label: string; current: number; min?: number; make: (n: number) => EncounterCommand; hint?: (n: number) => string | null;
}) {
  const [text, setText] = useDraft(`set:${id}`);
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const n = Number(text);
  const valid = isInt(text) && n >= min;
  const note = valid ? hint?.(n) : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && (await send(make(n)))) setText(null);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <Field label={`${label} (now ${current})`} className="flex-1">
          {(fid) => <Input id={fid} type="number" min={min} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setText(null)} />}
        </Field>
        <Button type="submit" variant="outline" disabled={!valid || busy}>Set</Button>
      </div>
      {note && <p className="text-xs text-warn">{note}</p>}
    </form>
  );
}

function EditFields({ c }: { c: CombatantDto }) {
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const [f, setF] = useState({ name: c.name, armorClass: String(c.armorClass), speedFt: String(c.speedFt), initiativeModifier: String(c.initiativeModifier), notes: c.notes });
  const patch: EditableCombatantPatch = {};
  if (f.name !== c.name) patch.name = f.name;
  if (f.armorClass !== String(c.armorClass)) patch.armorClass = Number(f.armorClass);
  if (f.speedFt !== String(c.speedFt)) patch.speedFt = Number(f.speedFt);
  if (f.initiativeModifier !== String(c.initiativeModifier)) patch.initiativeModifier = Number(f.initiativeModifier);
  if (f.notes !== c.notes) patch.notes = f.notes;
  const valid = f.name.trim() !== '' && isInt(f.armorClass) && isInt(f.speedFt) && isInt(f.initiativeModifier);
  const dirty = Object.keys(patch).length > 0;
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }) });
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid && dirty) void send({ type: 'UPDATE_COMBATANT', combatantId: c.id, patch }); }} className="grid grid-cols-3 gap-2 border-t border-border pt-3">
      <Field label="Name" className="col-span-3">{(id) => <Input id={id} {...bind('name')} />}</Field>
      <Field label="AC">{(id) => <Input id={id} type="number" {...bind('armorClass')} />}</Field>
      <Field label="Speed ft">{(id) => <Input id={id} type="number" {...bind('speedFt')} />}</Field>
      <Field label="Init mod">{(id) => <Input id={id} type="number" {...bind('initiativeModifier')} />}</Field>
      <Field label="Notes" className="col-span-3">{(id) => <Textarea id={id} {...bind('notes')} />}</Field>
      <div className="col-span-3 flex justify-end"><Button type="submit" variant="outline" disabled={!valid || !dirty || busy}>Save details</Button></div>
    </form>
  );
}

function Conditions({ c, locked, conditions }: { c: CombatantDto; locked: boolean; conditions: ConditionDto[] }) {
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const [editing, setEditing] = useState<ConditionDto | null>();
  const snap = useStore((s) => s.snapshot)!;
  const badges = conditionBadges(conditions, c.exhaustionLevel);
  return (
    <section aria-label="Conditions" className="flex flex-col gap-3 border-t border-border pt-3">
      <h3 className="label">Conditions</h3>
      {badges.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
      <ul className="flex flex-col gap-3">
        {badges.filter((b) => b.key !== 'exhaustion').map((b) => {
          const apps = conditions.filter((x) => x.conditionKey === b.key);
          return (
            <li key={b.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="amber">{b.label}{b.count > 1 && ` ×${b.count} sources`}</Badge>
                {b.count > 1 && !locked && (
                  <Button variant="ghost" aria-label={`Remove all ${b.count} sources of ${b.label} from ${c.name}`} disabled={busy} onClick={() => void send({ type: 'REMOVE_ALL_CONDITION_SOURCES', combatantId: c.id, conditionKey: b.key as ConditionKey })}>
                    Remove all sources
                  </Button>
                )}
              </div>
              <ul className="ml-2 flex flex-col gap-1 border-l border-border pl-3">
                {apps.map((a) => {
                  const timer = snap.timing.effects.find((e) => e.id === a.effectId);
                  const review = timer ? effectReview(snap, timer) : [];
                  return <li key={a.id} className="flex flex-col gap-1 text-sm">
                    <p className="break-words"><span className="text-warn">└</span> {a.sourceLabel || <span className="text-muted-foreground">no source</span>}{a.notes && <span className="text-muted-foreground"> — {a.notes}</span>}</p>
                    <p className="text-xs text-warn">{conditionDurationDescription(snap, a)}</p>
                    {review.map((problem) => <p key={problem} className="text-xs text-warn">Review required: {problem}. Edit this condition's duration or remove it.</p>)}
                    {!locked && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} aria-label={`Edit ${b.label} from ${a.sourceLabel || 'unnamed source'}`} onClick={() => setEditing(a)}>Edit duration / source</Button><Button variant="ghost" disabled={busy} aria-label={`Remove ${b.label} from ${a.sourceLabel || 'unnamed source'}`} onClick={() => void send({ type: 'REMOVE_CONDITION', applicationId: a.id })}>Remove</Button></div>}
                  </li>;
                })}
              </ul>
              <p className="text-xs text-muted-foreground">{CONDITION_RULES[b.key]}</p>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1">
        <Field label="Exhaustion level (0–6)">
          {(id) => (
            <Select id={id} value={c.exhaustionLevel} disabled={locked || busy || c.removedAt !== null} onChange={(e) => void send({ type: 'SET_EXHAUSTION', combatantId: c.id, level: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? '0 — none' : `Level ${n}`}</option>)}
            </Select>
          )}
        </Field>
        {c.exhaustionLevel > 0 && <p className="text-xs text-muted-foreground">D20 Tests −{2 * c.exhaustionLevel}, Speed −{5 * c.exhaustionLevel} ft (reference only — stored stats are unchanged).</p>}
        {c.exhaustionLevel === 6 && <p role="alert" className="border border-warn p-2 text-xs text-warn">WARNING: level 6 exhaustion is death under the 2024 rules. The app does not mark anyone dead — confirm the outcome, then exclude or remove {c.name} if needed.</p>}
      </div>

      {!locked && c.removedAt === null && <Button variant="outline" disabled={busy || snap.timing.effects.length >= 500} onClick={() => setEditing(null)}>Add condition</Button>}
      {editing !== undefined && <ConditionEditor combatantId={c.id} application={editing} close={() => setEditing(undefined)} />}
    </section>
  );
}

function RulesReference() {
  return (
    <details className="border-t border-border pt-3">
      <summary className="label">Rules reference · {RULES_VERSION}</summary>
      <dl className="mt-3 flex flex-col gap-2 text-xs">
        {Object.entries(CONDITION_RULES).map(([k, v]) => (
          <div key={k}><dt className="text-warn">{cap(k)}</dt><dd className="text-muted-foreground">{v}</dd></div>
        ))}
      </dl>
    </details>
  );
}
