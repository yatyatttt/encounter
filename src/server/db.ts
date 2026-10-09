// Data directory, SQLite connection (pragmas), and migrations.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup } from './backup';
import type { Db } from './repo';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function resolveDataDir(): string {
  if (process.env.ENCOUNTER_DATA_DIR) return process.env.ENCOUNTER_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Encounter');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Encounter');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'Encounter');
}

/** Opens (creating if needed) <dataDir>/encounter.sqlite and applies pending migrations. */
export async function openDb(dataDir: string): Promise<Db> {
  mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
  const sqlite = new Database(join(dataDir, 'encounter.sqlite'));
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL');
    sqlite.pragma('busy_timeout = 3000');
    sqlite.pragma('foreign_keys = ON');
    if (sqlite.pragma('foreign_keys', { simple: true }) !== 1 || sqlite.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new Error('Could not enable required SQLite settings (foreign keys, WAL)');
    }
    const db = drizzle(sqlite);

    const total = (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length;
    const hasTable = sqlite.prepare("select 1 from sqlite_master where name = '__drizzle_migrations'").get();
    const applied = hasTable ? (sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n : 0;
    if (applied > total) throw new Error('This database was created by a newer version of Encounter. Update the app; your data was not touched.');
    if (applied > 0 && applied < total) await createBackup(sqlite, join(dataDir, 'backups'), 'pre-migration');
    migrate(db, { migrationsFolder: MIGRATIONS });
    return db;
  } catch (e) {
    sqlite.close();
    throw e;
  }
}

export const schemaVersion = (db: Db): number =>
  (db.$client.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n;
