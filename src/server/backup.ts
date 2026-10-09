// SQLite backups: online-backup API -> temp file -> integrity check -> atomic rename into backups/.
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupInfo } from '../shared/contract';
import type { Db } from './repo';
import { appSettings } from './schema';

type Reason = BackupInfo['reason'];
const FILE = /^backup-.+-(manual|auto|pre-restore|pre-migration)\.sqlite$/;
const KEEP_AUTO = 20;

export async function createBackup(sqlite: Database.Database, backupDir: string, reason: Reason): Promise<BackupInfo> {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const tmp = join(backupDir, `.tmp-${randomUUID()}.sqlite`);
  try {
    await sqlite.backup(tmp);
    const copy = new Database(tmp);
    try {
      const result = copy.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`Backup failed its integrity check: ${String(result)}`);
    } finally {
      copy.close();
    }
    const createdAt = Date.now();
    const id = `backup-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}-${reason}.sqlite`;
    renameSync(tmp, join(backupDir, id));
    return { id, createdAt, reason, sizeBytes: statSync(join(backupDir, id)).size };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function listBackups(backupDir: string): BackupInfo[] {
  try {
    return readdirSync(backupDir)
      .flatMap((id) => {
        const m = FILE.exec(id);
        if (!m) return [];
        const st = statSync(join(backupDir, id));
        return [{ id, createdAt: Math.round(st.mtimeMs), reason: m[1] as Reason, sizeBytes: st.size }];
      })
      .sort((a, b) => (a.id < b.id ? 1 : -1)); // names embed an ISO timestamp: newest first
  } catch {
    return [];
  }
}

export const latestBackup = (backupDir: string): BackupInfo | null => listBackups(backupDir)[0] ?? null;

const localDay = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
let autoInFlight = false;

/** Fire-and-forget: at most one automatic backup per local calendar day; keeps the newest 20. Never throws. */
export async function maybeAutoBackup(db: Db, backupDir: string): Promise<void> {
  if (autoInFlight) return;
  autoInFlight = true;
  try {
    const last = db.select().from(appSettings).where(eq(appSettings.key, 'lastAutoBackupDay')).get()?.value;
    if (last === localDay()) return;
    await createBackup(db.$client, backupDir, 'auto');
    const value = localDay();
    db.insert(appSettings).values({ key: 'lastAutoBackupDay', value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
    for (const old of listBackups(backupDir).filter((b) => b.reason === 'auto').slice(KEEP_AUTO)) rmSync(join(backupDir, old.id), { force: true });
  } catch (e) {
    console.error('Automatic backup failed:', e instanceof Error ? e.message : e);
  } finally {
    autoInFlight = false;
  }
}
