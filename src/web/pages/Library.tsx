import { useCallback, useEffect, useState } from 'react';
import { api, ApiFailure } from '@/api';
import type { Template } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Input, Select, Field } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, Confirm } from '@/components/ui/dialog';
import { CombatantForm, emptyForm, formFromTemplate, formToInput, type FormState } from '@/components/CombatantForm';

export function Library() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Template | null>(null);

  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    setList(null);
    const timer = setTimeout(() => {
      api.templates({ q: q.trim() || undefined, kind: kind || undefined, archived })
        .then((templates) => { if (current) { setList(templates); setError(null); } })
        .catch((error: Error) => { if (current) setError(error.message); });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [q, kind, archived, reload]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); refresh(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="label text-sm text-foreground">Combatant library</h1>
        <Button onClick={() => setEditing('new')}>+ New Template</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Search" className="w-64">{(id) => <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name or tag" />}</Field>
        <Field label="Kind" className="w-40">
          {(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All</option><option value="player">Player</option><option value="enemy">Enemy</option><option value="npc">NPC</option></Select>}
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-[#3fcf8e]" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </div>
      {error && <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{error}</p>}
      {list && list.length === 0 ? (
        <div className="border border-border bg-card p-8 text-center">
          <p className="mb-4 text-muted-foreground">{q || kind ? 'No templates match.' : archived ? 'No archived templates.' : 'No templates yet.'}</p>
          {!archived && <Button onClick={() => setEditing('new')}>Create a template</Button>}
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-card">
          <table>
            <caption className="sr-only">Combatant templates</caption>
            <thead>
              <tr className="border-b border-border text-left">
                {['Name', 'Kind', 'HP', 'AC', 'Init', 'Speed', 'Tags'].map((h) => <th key={h} scope="col" className="label p-3 font-medium">{h}</th>)}
                <th scope="col" className="label p-3 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {(list ?? []).map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0 hover:bg-accent">
                  <td className="p-3 text-base">{t.name} {t.archivedAt && <Badge>archived</Badge>}</td>
                  <td className="p-3 uppercase text-muted-foreground">{t.kind}</td>
                  <td className="p-3">{t.maxHp}</td>
                  <td className="p-3">{t.armorClass}</td>
                  <td className="p-3">{t.initiativeModifier >= 0 ? '+' : ''}{t.initiativeModifier}</td>
                  <td className="p-3">{t.speedFt} ft</td>
                  <td className="p-3 text-warn">{t.tags.join(', ') || <span className="text-muted-foreground">—</span>}</td>
                  <td className="whitespace-nowrap p-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(() => api.duplicateTemplate(t.id))} aria-label={`Duplicate ${t.name}`}>Duplicate</Button>
                    {t.archivedAt !== null && <Button size="sm" className="min-h-11" variant="ghost" onClick={() => void act(() => api.unarchiveTemplate(t.id))} aria-label={`Unarchive ${t.name}`}>Unarchive</Button>}
                    {!t.archivedAt && <Button size="sm" variant="ghost" onClick={() => setArchiving(t)} aria-label={`Archive ${t.name}`}>Archive</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <Confirm
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive template"
        confirmLabel="Archive"
        onConfirm={() => act(() => api.archiveTemplate(archiving!.id))}
      >
        Archive <strong>{archiving?.name}</strong>? It is hidden from the library and the add-combatant search. Encounters already using it keep their own copies.
      </Confirm>
    </div>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>(template ? formFromTemplate(template) : emptyForm());
  const [errors, setErrors] = useState<Record<string, string[]> | null>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErrors(null); setMessage(undefined);
    try {
      const body = formToInput(form, true);
      await (template ? api.updateTemplate(template.id, body) : api.createTemplate(body));
      onSaved();
    } catch (err) {
      const f = err as ApiFailure;
      setErrors(f.fieldErrors ?? null);
      setMessage(f.message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={template ? `Edit ${template.name}` : 'New template'} className="max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <CombatantForm form={form} setForm={setForm} errors={errors} tags />
          {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{template ? 'Save changes' : 'Create template'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
