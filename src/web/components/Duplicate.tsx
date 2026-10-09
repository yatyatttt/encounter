import { useState } from 'react';
import { api } from '@/api';
import { useStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';

/** Duplicate the current encounter into a new draft (available in builder, tracker and completed views). */
export function DuplicateButton() {
  const snap = useStore((s) => s.snapshot)!;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [hpSource, setHpSource] = useState<'starting' | 'current'>('starting');
  const [copyConditions, setCopyConditions] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const copy = await api.duplicateEncounter(snap.id, { name: name.trim() || undefined, hpSource, copyConditions });
      setOpen(false);
      location.hash = `#/encounter/${copy.id}`;
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Duplicate</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Duplicate ${snap.name}`} description="Creates a new draft. The original is not changed and no library HP is updated.">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="New name (optional)">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${snap.name} (copy)`} />}</Field>
            <Segmented label="Starting HP / temp HP from" value={hpSource} onChange={setHpSource} options={[{ value: 'starting', label: 'Starting values' }, { value: 'current', label: 'Current values' }]} />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" className="size-5 accent-[#3fcf8e]" checked={copyConditions} onChange={(e) => setCopyConditions(e.target.checked)} />
              Copy manual conditions (cleared by default)
            </label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>Create draft copy</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
