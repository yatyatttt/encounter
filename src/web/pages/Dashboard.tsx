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
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<EncounterSummary | null>(null);

  const load = useCallback(() => {
    api.encounters().then((l) => { setList(l); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="label text-sm text-foreground">Dashboard</h1>
        <Button onClick={() => setCreating(true)}>+ New Encounter</Button>
      </div>
      {error && <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{error} <Button size="sm" variant="outline" onClick={load}>Retry</Button></p>}
      {list && list.length === 0 && (
        <div className="border border-border bg-card p-8 text-center">
          <p className="mb-4 text-muted-foreground">No encounters yet.</p>
          <Button onClick={() => setCreating(true)}>Create your first encounter</Button>
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
                  {(e.status === 'active' || e.status === 'paused') && <Badge tone={e.status === 'active' ? 'green' : 'amber'}>{e.status} · round {e.round}</Badge>}
                  <span className="text-xs text-muted-foreground">{e.combatantCount} combatants · {new Date(e.updatedAt).toLocaleString()}</span>
                  <Button size="sm" onClick={() => { location.hash = `#/encounter/${e.id}`; }}>{g.action}</Button>
                  {e.status !== 'active' && <Button size="sm" variant="outline" onClick={() => setArchiving(e)}>Archive</Button>}
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
            load();
          } catch (e) { setError((e as Error).message); load(); }
        }}
      >
        Archive <strong>{archiving?.name}</strong>? It disappears from this list; the data stays in your backups and exports.
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
