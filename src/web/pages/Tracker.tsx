import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { conditionBadges, hpBar } from '@/helpers';
import type { CombatantDto, JoinPolicy, TurnPolicy } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Confirm } from '@/components/ui/dialog';
import { SaveStatus } from '@/components/Save';
import { Detail } from '@/components/Detail';
import { AddCombatant } from '@/components/AddCombatant';
import { DuplicateButton } from '@/components/Duplicate';
import { cn } from '@/lib/utils';

export function Tracker() {
  const snap = useStore((s) => s.snapshot)!;
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.save === 'saving');
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState(false);
  const [reinstating, setReinstating] = useState<CombatantDto | null>(null);
  const [join, setJoin] = useState<JoinPolicy>('next-round');

  const running = snap.status === 'active';
  const paused = snap.status === 'paused';
  const completed = snap.status === 'completed';
  const byId = new Map(snap.combatants.map((c) => [c.id, c]));
  const active = snap.activeCombatantId ? byId.get(snap.activeCombatantId) : undefined;
  const nextId = snap.schedule.pendingIds[0];
  const inRound = new Set([...(snap.activeCombatantId ? [snap.activeCombatantId] : []), ...snap.schedule.pendingIds, ...snap.schedule.actedIds]);
  const live = snap.combatants.filter((c) => c.removedAt === null);
  const rows = live.filter((c) => inRound.has(c.id) || c.eligible);
  const excluded = live.filter((c) => !rows.includes(c));
  const removed = snap.combatants.filter((c) => c.removedAt !== null);

  // N = Next Turn, only when it is safe: not typing, no dialog/menu open, no save pending, action enabled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if ((e.target as HTMLElement | null)?.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return;
      const s = useStore.getState();
      if (s.save === 'saving' || s.snapshot?.status !== 'active') return;
      e.preventDefault();
      void s.send({ type: 'NEXT_TURN' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-4">
          <h1 className="text-xl">{snap.name}</h1>
          <span className="text-lg text-primary">ROUND {snap.round}</span>
          {paused && <Badge tone="amber">PAUSED</Badge>}
          {completed && <Badge>COMPLETED</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SaveStatus />
          {running && <Button variant="outline" disabled={busy} onClick={() => void send({ type: 'PAUSE_COMBAT' })}>Pause</Button>}
          {paused && <Button disabled={busy} onClick={() => void send({ type: 'RESUME_COMBAT' })}>Resume</Button>}
          {(running || paused) && <Button variant="outline" disabled={busy} onClick={() => setEnding(true)}>End Combat</Button>}
          <DuplicateButton />
        </div>
      </div>

      {!completed && (
        <section aria-label="Turn control" className="flex flex-wrap items-center justify-between gap-4 border border-border bg-card p-4">
          <div className="flex flex-wrap gap-x-10 gap-y-2">
            <div><p className="label">Active</p><p className="text-lg text-primary">{active ? active.name : paused ? 'paused' : '—'}</p></div>
            <div><p className="label">Next</p><p className="text-lg">{nextId ? byId.get(nextId)?.name : running ? `round ${snap.round + 1} starts` : '—'}</p></div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" disabled={busy || !running || !snap.canPreviousTurn} onClick={() => void send({ type: 'PREVIOUS_TURN' })}>Previous Turn</Button>
            <Button size="lg" disabled={busy || !running} onClick={() => void send({ type: 'NEXT_TURN' })} aria-keyshortcuts="N">Next Turn <kbd className="border border-primary-foreground/40 px-1 text-xs">N</kbd></Button>
          </div>
        </section>
      )}
      {paused && <p className="text-sm text-warn">Combat is paused: turns do not advance. HP and condition corrections still work. Press Resume to continue.</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="overflow-x-auto border border-border bg-card">
            <table>
              <caption className="sr-only">Initiative order for round {snap.round}</caption>
              <thead>
                <tr className="border-b border-border text-left">
                  {['Init', 'Name', 'HP / Max', 'Temp', 'AC', 'Conditions'].map((h) => <th key={h} scope="col" className="label p-3 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const isActive = c.id === snap.activeCombatantId;
                  const isSel = c.id === selectedId;
                  const acted = snap.schedule.actedIds.includes(c.id);
                  const frozen = snap.schedule.orderKeys[c.id]?.initiative;
                  const badges = conditionBadges(snap.conditions.filter((x) => x.targetCombatantId === c.id), c.exhaustionLevel);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => select(c.id)}
                      className={cn('cursor-pointer border-b border-border last:border-b-0 hover:bg-accent', isSel && 'bg-accent outline outline-1 -outline-offset-1 outline-ring/60', isActive && 'text-primary', acted && !isActive && 'opacity-60')}
                    >
                      <td className="p-3 align-middle text-base">
                        {frozen ?? c.initiativeTotal ?? '—'}
                        {frozen !== undefined && c.initiativeTotal !== null && c.initiativeTotal !== frozen && <span className="block text-[0.7rem] text-warn">→ {c.initiativeTotal} next round</span>}
                        {frozen === undefined && <span className="block text-[0.7rem] text-warn">joins next round</span>}
                      </td>
                      <td className="p-3 align-middle">
                        <button type="button" aria-pressed={isSel} onClick={(e) => { e.stopPropagation(); select(c.id); }} className="min-h-11 cursor-pointer text-left text-base">
                          <span aria-hidden className="inline-block w-4 text-primary">{isActive ? '>' : ''}</span>{c.name}
                        </button>
                        <span className="ml-5 flex gap-2 text-[0.7rem] uppercase tracking-wider">
                          {isActive && <span className="text-primary">Active</span>}
                          {isSel && <span className="text-primary">{isActive ? '· ' : ''}Selected</span>}
                          {acted && !isActive && <span className="text-muted-foreground">Acted</span>}
                        </span>
                      </td>
                      <td className="p-3 align-middle">
                        {c.currentHp === 0 ? <span className="text-destructive">0 HP</span> : <span className="text-base">{c.currentHp}</span>} <span className="text-muted-foreground">/ {c.maxHp}</span>
                        <span aria-hidden className={cn('block tracking-tighter', c.currentHp === 0 ? 'text-destructive' : 'text-primary')}>{hpBar(c.currentHp, c.maxHp)}</span>
                      </td>
                      <td className={cn('p-3 align-middle', c.tempHp > 0 ? 'text-warn' : 'text-muted-foreground')}>{c.tempHp}</td>
                      <td className="p-3 align-middle">{c.armorClass}</td>
                      <td className="p-3 align-middle">
                        {badges.length ? (
                          <span className="flex flex-wrap gap-1">{badges.map((b) => <Badge key={b.key} tone="amber">{b.label}{b.count > 1 && ` ×${b.count}`}</Badge>)}</span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!completed && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setAdding(true)} disabled={busy}>+ Add Combatant</Button>
            </div>
          )}

          {(excluded.length > 0 || removed.length > 0) && (
            <details className="border border-border bg-card p-3">
              <summary className="label">Removed / excluded · {excluded.length + removed.length}</summary>
              <ul className="mt-3 flex flex-col">
                {excluded.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 border-t border-border py-2">
                    <button type="button" onClick={() => select(c.id)} className="min-h-11 cursor-pointer text-left hover:text-primary">{c.name}{c.id === selectedId && <span className="label ml-2 text-primary">Selected</span>}</button>
                    <Badge tone="amber">Not scheduled</Badge>
                    <span className="text-xs text-muted-foreground">{c.currentHp === 0 ? '0 HP' : `${c.currentHp} HP`} · {c.turnPolicy === 'exclude' ? 'excluded by policy' : c.initiativeTotal === null ? 'no initiative' : 'skipped by HP policy'}</span>
                    {!completed && (
                      <label className="ml-auto flex items-center gap-2 text-xs"><span className="label">Policy</span>
                        <Select className="w-52" value={c.turnPolicy} disabled={busy} onChange={(e) => void send({ type: 'SET_TURN_POLICY', combatantId: c.id, policy: e.target.value as TurnPolicy })}>
                          <option value="default">Default</option><option value="include">Always include</option><option value="exclude">Exclude</option>
                        </Select>
                      </label>
                    )}
                  </li>
                ))}
                {removed.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 border-t border-border py-2">
                    <button type="button" onClick={() => select(c.id)} className="min-h-11 cursor-pointer text-left text-muted-foreground hover:text-foreground">{c.name}</button>
                    <Badge>Removed</Badge>
                    {!completed && <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => { setJoin('next-round'); setReinstating(c); }}>Reinstate…</Button>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <Detail draft={false} />
      </div>

      <AddCombatant open={adding} onOpenChange={setAdding} />
      <Confirm open={ending} onOpenChange={setEnding} title={`End combat: ${snap.name}?`} confirmLabel="End combat" onConfirm={() => send({ type: 'COMPLETE_COMBAT' })}>
        End combat for <strong>{snap.name}</strong> at round {snap.round}? It becomes a read-only completed record; you can duplicate it into a new draft.
      </Confirm>
      <Confirm
        open={!!reinstating}
        onOpenChange={(o) => !o && setReinstating(null)}
        title={`Reinstate ${reinstating?.name}?`}
        confirmLabel="Reinstate"
        onConfirm={() => send({ type: 'REINSTATE_COMBATANT', combatantId: reinstating!.id, joinPolicy: join })}
      >
        <div className="flex flex-col gap-3">
          <Segmented label="Rejoins combat" value={join} onChange={setJoin} options={[{ value: 'next-round', label: 'Next round' }, { value: 'current-round', label: 'Remaining current round' }]} />
          <p className="text-xs text-muted-foreground">A combatant that already acted this round does not get a second turn.</p>
        </div>
      </Confirm>
    </div>
  );
}
