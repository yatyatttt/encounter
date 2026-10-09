import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { ExportFile, RestorePreview, Settings as SettingsDto } from '../../shared/contract';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/dialog';

const when = (t: number) => new Date(t).toLocaleString();
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex flex-wrap gap-x-6 border-b border-border py-2 last:border-b-0">
    <dt className="label w-40 pt-1">{k}</dt>
    <dd className="min-w-0 flex-1 break-all">{v}</dd>
  </div>
);

export function Settings() {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; data: ExportFile; preview: RestorePreview } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = () => api.settings().then((x) => { setS(x); setError(null); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setInfo(null); setError(null);
    try { await fn(); } catch (e) { setError(`${label} failed: ${(e as Error).message}`); }
  };

  const backup = () => run('Backup', async () => {
    const b = await api.backup();
    setInfo(`Backup created ${when(b.createdAt)} (${Math.round(b.sizeBytes / 1024)} KB).`);
    await load();
  });

  const exportJson = () => run('Export', async () => {
    const data = await api.exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `encounter-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setInfo('Export downloaded.');
  });

  const choose = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setFile(null);
    if (!f) return;
    void run('Restore preview', async () => {
      let data: ExportFile;
      try { data = JSON.parse(await f.text()) as ExportFile; } catch { throw new Error('That file is not valid JSON.'); }
      setFile({ name: f.name, data, preview: await api.restorePreview(data) });
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="label text-sm text-foreground">Settings / data</h1>
      {error && <p role="alert" className="border border-destructive p-3 text-sm text-destructive">{error}</p>}
      {info && <p role="status" className="border border-primary p-3 text-sm text-primary">{info}</p>}

      <section aria-labelledby="st-info" className="border border-border bg-card p-4">
        <h2 id="st-info" className="label mb-2">Application</h2>
        {s ? (
          <dl>
            <Row k="Data folder" v={s.dataDir} />
            <Row k="Backup folder" v={s.backupDir} />
            <Row k="Latest backup" v={s.latestBackup ? `${when(s.latestBackup.createdAt)} (${s.latestBackup.reason})` : 'none yet'} />
            <Row k="App version" v={s.appVersion} />
            <Row k="Rules version" v={s.rulesVersion} />
            <Row k="Schema version" v={s.schemaVersion} />
          </dl>
        ) : <p className="text-muted-foreground">{error ? 'Unavailable.' : 'Loading…'}</p>}
      </section>

      <section aria-labelledby="st-bk" className="flex flex-col gap-3 border border-border bg-card p-4">
        <h2 id="st-bk" className="label">Backup &amp; export</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void backup()}>Backup now</Button>
          <Button variant="outline" onClick={() => void exportJson()}>Export JSON</Button>
        </div>
      </section>

      <section aria-labelledby="st-rs" className="flex flex-col gap-3 border border-border bg-card p-4">
        <h2 id="st-rs" className="label">Restore from JSON</h2>
        <p className="text-sm text-muted-foreground">Restore replaces the entire dataset (it is not a merge). A safety backup of the current data is made first.</p>
        <label className="label">
          Export file
          <input type="file" accept="application/json,.json" onChange={choose} className="mt-1 block min-h-11 w-full border border-input bg-background p-2 text-sm text-foreground" />
        </label>
        {file && (
          <div className="border border-warn p-3 text-sm">
            <p><strong>{file.name}</strong> — format v{file.preview.formatVersion}, exported {when(file.preview.exportedAt)}</p>
            <p className="mt-1">Contains {file.preview.counts.templates} templates, {file.preview.counts.encounters} encounters, {file.preview.counts.combatants} combatants, {file.preview.counts.conditions} conditions.</p>
            <p className="mt-2 text-warn">Warning: restoring REPLACES all current templates and encounters. Pause or finish any running combat first.</p>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => setConfirm(true)}>Restore…</Button>
              <Button variant="outline" onClick={() => setFile(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </section>

      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Replace all data?"
        confirmLabel="Replace data and reload"
        onConfirm={async () => {
          try {
            await api.restore(file!.data);
            location.hash = '#/';
            location.reload();
            return true;
          } catch (e) { setError(`Restore failed: ${(e as Error).message} Nothing was replaced.`); return false; }
        }}
      >
        This replaces everything with <strong>{file?.name}</strong>. The current dataset is backed up first, then the app reloads.
      </Confirm>
    </div>
  );
}
