import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api';
import type { EncounterStatus, EncounterSummary } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, Confirm } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

const GROUPS: { status: EncounterStatus; title: string; action: string }[] = [
  { status: 'active', title: 'Continue active combat', action: 'Continue' },
  { status: 'paused', title: 'Paused encounters', action: 'Resume' },
  { status: 'draft', title: 'Recent drafts', action: 'Open' },
  { status: 'completed', title: 'Completed', action: 'Review' },
];

export function Dashboard() {
  const [list, setList] = useState<EncounterSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<EncounterSummary | null>(null);

  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setList(null);
    api.encounters({ archived })
      .then((encounters) => { if (current) { setList(encounters); setError(null); } })
      .catch((error: Error) => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [archived, reload]);

  const unarchive = async (id: string) => {
    setRestoring(id);
    try {
      const snap = await api.encounter(id);
      await api.command(id, { expectedVersion: snap.version, command: { type: 'UNARCHIVE_ENCOUNTER' } });
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setRestoring(null); }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="label text-sm text-foreground">Dashboard</h1>
        <Button onClick={() => setCreating(true)}>+ New Encounter</Button>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-primary" checked={archived} onChange={(e) => { setArchived(e.target.checked); }} /> Show archived</label>
      {error && <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={refresh}>Retry</Button></p>}
      {list && list.length === 0 && (
        <div className="border border-border bg-card p-8 text-center">
          <p className="mb-4 text-muted-foreground">{archived ? 'No archived encounters.' : 'No encounters yet.'}</p>
          {!archived && <Button onClick={() => setCreating(true)}>Create your first encounter</Button>}
        </div>
      )}
      {GROUPS.map((g) => {
        const rows = (list ?? []).filter((e) => e.status === g.status).sort((a, b) => b.updatedAt - a.updatedAt);
        if (!rows.length) return null;
        return (
          <section key={g.status} aria-labelledby={`g-${g.status}`}>
            <h2 id={`g-${g.status}`} className="label mb-2">{g.title} · {rows.length}</h2>
            <ul className="border border-border bg-card">
              {rows.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-4 border-b border-border p-3 last:border-b-0">
                  <a href={`#/encounter/${e.id}`} className="min-w-48 flex-1 text-base hover:text-primary">{e.name}</a>
                  {e.archivedAt !== null && <Badge>Archived</Badge>}
                  {(e.status === 'active' || e.status === 'paused') && <Badge tone={e.status === 'active' ? 'green' : 'amber'}>{e.status} · round {e.round}</Badge>}
                  <span className="text-xs text-muted-foreground">{e.combatantCount} combatants · {new Date(e.updatedAt).toLocaleString()}</span>
                  <Button size="sm" onClick={() => { location.hash = `#/encounter/${e.id}`; }}>{g.action}</Button>
                  {e.archivedAt !== null && <Button size="sm" className="min-h-11" variant="outline" disabled={restoring !== null} onClick={() => void unarchive(e.id)} aria-label={`Unarchive ${e.name}`}>{restoring === e.id ? 'Unarchiving…' : 'Unarchive'}</Button>}
                  {e.archivedAt === null && e.status !== 'active' && <Button size="sm" variant="outline" onClick={() => setArchiving(e)}>Archive</Button>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <NewEncounter open={creating} onOpenChange={setCreating} />
      <Confirm
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive encounter"
        confirmLabel="Archive"
        onConfirm={async () => {
          try {
            const snap = await api.encounter(archiving!.id);
            await api.command(snap.id, { expectedVersion: snap.version, command: { type: 'ARCHIVE_ENCOUNTER' } });
            refresh();
          } catch (e) { setError((e as Error).message); refresh(); }
        }}
      >
        Archive <strong>{archiving?.name}</strong>? It is hidden from the normal dashboard. Use Show archived to find it and unarchive it later.
      </Confirm>
    </div>
  );
}

function NewEncounter({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const snap = await api.createEncounter(name.trim());
      onOpenChange(false); setName('');
      location.hash = `#/encounter/${snap.id}`;
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New encounter">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Encounter name" error={error}>{(id) => <Input id={id} autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ambush at the Rail Station" />}</Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>Create &amp; open builder</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
