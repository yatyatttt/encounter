// API + persistence tests: real SQLite in a temp dir, requests via app.request() (no network).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Db } from './repo';
import type { Template } from '../shared/contract';
import { createApp } from './app';
import { replaceAll, validateExport } from './data';
import { openDb } from './db';

const PORT = 8787;
const dirs: string[] = [];
const open: Db[] = [];
afterEach(() => {
  while (open.length) open.pop()!.$client.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function fixture(dir = mkdtempSync(join(tmpdir(), 'encounter-test-')), autoBackup = false) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const db = await openDb(dir);
  open.push(db);
  const app = createApp(db, { dataDir: dir, port: PORT, autoBackup });
  return { dir, db, app, call: caller(app) };
}

function caller(app: Hono) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { Host: `127.0.0.1:${PORT}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}
type Call = ReturnType<typeof caller>;

const guard = { kind: 'enemy', name: 'Guard', maxHp: 11, armorClass: 16, initiativeModifier: 1, speedFt: 30 };

async function command(call: Call, id: string, expectedVersion: number, cmd: object) {
  return call('POST', `/encounters/${id}/commands`, { expectedVersion, command: cmd });
}

/** Template -> encounter -> add `n` guards with distinct initiative. Returns the latest snapshot. */
async function guardEncounter(call: Call, name = 'Ambush', n = 6) {
  const t = (await call('POST', '/templates', guard)).body as Template;
  const enc = (await call('POST', '/encounters', { name })).body;
  const added = await command(call, enc.id, 1, { type: 'ADD_COMBATANTS', entries: [{ templateId: t.id, quantity: n }] });
  expect(added.status).toBe(200);
  const snap = added.body.snapshot;
  const init = await command(call, enc.id, snap.version, {
    type: 'SET_INITIATIVE',
    entries: [...snap.combatants].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)).map((c: { id: string }, i: number) => ({ combatantId: c.id, mode: 'total', total: 20 - i })),
  });
  return { template: t, snapshot: init.body.snapshot };
}

describe('API', () => {
  it('runs the full scenario and survives a restart', async () => {
    const f = await fixture();
    const { call } = f;
    const { template, snapshot } = await guardEncounter(call);
    const id = snapshot.id;
    const guards = snapshot.combatants;
    expect(guards.map((g: { name: string }) => g.name)).toEqual(['Guard 1', 'Guard 2', 'Guard 3', 'Guard 4', 'Guard 5', 'Guard 6']);
    expect(new Set(guards.map((g: { id: string }) => g.id)).size).toBe(6);

    // damage Guard 2 only
    let r = await command(call, id, snapshot.version, { type: 'APPLY_DAMAGE', combatantId: guards[1].id, amount: 4 });
    expect(r.body.affectedIds).toEqual([guards[1].id]);
    expect(r.body.snapshot.combatants.map((c: { currentHp: number }) => c.currentHp)).toEqual([11, 7, 11, 11, 11, 11]);

    // editing/archiving the template leaves prepared instances alone
    await call('PATCH', `/templates/${template.id}`, { name: 'Elite Guard', maxHp: 99 });
    await call('POST', `/templates/${template.id}/archive`);
    const afterEdit = (await call('GET', `/encounters/${id}`)).body;
    expect(afterEdit.combatants.map((c: { name: string; maxHp: number }) => [c.name, c.maxHp])[0]).toEqual(['Guard 1', 11]);
    expect((await call('GET', '/templates')).body).toEqual([]);
    expect((await call('GET', '/templates?archived=1&q=elite')).body).toHaveLength(1);

    // start, then a full round
    r = await command(call, id, r.body.snapshot.version, { type: 'START_COMBAT' });
    expect([r.body.snapshot.status, r.body.snapshot.round, r.body.snapshot.activeCombatantId]).toEqual(['active', 1, guards[0].id]);
    const seen = [r.body.snapshot.activeCombatantId];
    for (let i = 0; i < 6; i++) {
      r = await command(call, id, r.body.snapshot.version, { type: 'NEXT_TURN' });
      seen.push(r.body.snapshot.activeCombatantId);
    }
    expect(seen).toEqual([...guards.map((g: { id: string }) => g.id), guards[0].id]);
    expect(r.body.snapshot.round).toBe(2);
    expect(r.body.snapshot.canPreviousTurn).toBe(true);

    // two stale writes: one wins, one conflicts
    const v = r.body.snapshot.version;
    const [a, b] = [
      await command(call, id, v, { type: 'APPLY_DAMAGE', combatantId: guards[2].id, amount: 1 }),
      await command(call, id, v, { type: 'APPLY_DAMAGE', combatantId: guards[3].id, amount: 1 }),
    ];
    expect([a.status, b.status]).toEqual([200, 409]);
    expect(b.body.error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: v + 1 });

    // "restart": reopen the same file; snapshot is identical
    const before = (await call('GET', `/encounters/${id}`)).body;
    expect(before.version).toBe(v + 1);
    f.db.$client.close();
    open.pop();
    const g = await fixture(f.dir);
    expect((await g.call('GET', `/encounters/${id}`)).body).toEqual(before);
    expect((await g.call('GET', '/encounters')).body).toMatchObject([{ id, status: 'active', round: 2, combatantCount: 6 }]);
  });

  it('allows one active encounter at a time', async () => {
    const { call } = await fixture();
    const one = (await guardEncounter(call, 'One', 2)).snapshot;
    const two = (await guardEncounter(call, 'Two', 2)).snapshot;
    const s1 = await command(call, one.id, one.version, { type: 'START_COMBAT' });
    expect(s1.status).toBe(200);
    const s2 = await command(call, two.id, two.version, { type: 'START_COMBAT' });
    expect(s2).toMatchObject({ status: 409, body: { error: { code: 'INVALID_STATE' } } });
    expect(s2.body.error.message).toMatch(/Pause/);
    expect((await command(call, one.id, s1.body.snapshot.version, { type: 'ARCHIVE_ENCOUNTER' })).status).toBe(409);
    const p = await command(call, one.id, s1.body.snapshot.version, { type: 'PAUSE_COMBAT' });
    expect((await command(call, two.id, two.version, { type: 'START_COMBAT' })).status).toBe(200);
    expect((await command(call, one.id, p.body.snapshot.version, { type: 'RESUME_COMBAT' })).status).toBe(409);
  });

  it('duplicates an encounter as a fresh draft', async () => {
    const { call } = await fixture();
    const { snapshot } = await guardEncounter(call, 'Original', 2);
    const dup = (await call('POST', `/encounters/${snapshot.id}/duplicate`)).body;
    expect([dup.name, dup.status, dup.round, dup.version]).toEqual(['Original (copy)', 'draft', 0, 1]);
    expect(dup.combatants.map((c: { id: string }) => c.id)).not.toEqual(expect.arrayContaining([snapshot.combatants[0].id]));
    expect(dup.combatants.every((c: { initiativeTotal: number | null }) => c.initiativeTotal === null)).toBe(true);
    expect((await call('GET', `/encounters/${snapshot.id}`)).body).toEqual(snapshot);
  });

  it('returns documented error shapes', async () => {
    const { app, call } = await fixture();
    const bad = await call('POST', '/templates', { ...guard, maxHp: 0, bogus: 1 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION');
    expect(bad.body.error.fieldErrors.maxHp).toBeDefined();
    expect((await call('GET', `/encounters/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('GET', '/encounters/not-a-uuid')).status).toBe(422);
    const enc = (await call('POST', '/encounters', { name: 'E' })).body;
    const cmd = await command(call, enc.id, 1, { type: 'SET_HP', combatantId: crypto.randomUUID(), value: 1 });
    expect(cmd.status).toBe(404);
    expect((await command(call, enc.id, 1, { type: 'NOPE' })).status).toBe(422);
    expect((await call('POST', '/encounters', { name: '' })).status).toBe(422);
    const raw = await app.request('/api/v1/encounters', { method: 'POST', headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
  });

  it('rejects bad Host, bad Origin and non-JSON bodies', async () => {
    const { app, call } = await fixture();
    expect((await call('GET', '/health', undefined, { Host: 'evil.example' })).status).toBe(403);
    expect((await call('GET', '/health', undefined, { Host: `localhost:${PORT}` })).status).toBe(200);
    expect((await call('POST', '/encounters', { name: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/encounters', { name: 'x' }, { Origin: 'http://localhost:5173' })).status).toBe(201);
    expect((await call('POST', '/encounters', { name: 'x' }, { Origin: `http://127.0.0.1:${PORT}` })).status).toBe(201);
    const text = await app.request('/api/v1/encounters', { method: 'POST', headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'text/plain' }, body: '{"name":"x"}' });
    expect(text.status).toBe(400);
    const health = await call('GET', '/health');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('rejects oversized bodies', async () => {
    const { call } = await fixture();
    const r = await call('POST', '/templates', { ...guard, notes: 'x'.repeat(1024 * 1024 + 1) });
    expect(r.status).toBe(413);
  });
});

describe('backups, export and restore', () => {
  it('creates a verified backup file and reports it in settings', async () => {
    const { call, dir } = await fixture();
    await guardEncounter(call);
    const b = await call('POST', '/data/backups');
    expect(b.status).toBe(200);
    expect(b.body.reason).toBe('manual');
    expect(readdirSync(join(dir, 'backups'))).toEqual([b.body.id]); // no temp files left behind
    const s = (await call('GET', '/settings')).body;
    expect(s.latestBackup.id).toBe(b.body.id);
    expect(s.dataDir).toBe(dir);
    expect(s.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('takes an automatic backup after the first mutation of the day', async () => {
    const { call, dir } = await fixture(undefined, true);
    await call('POST', '/encounters', { name: 'x' });
    await vi.waitFor(() => expect(readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('-auto.sqlite'))).toHaveLength(1));
    await call('POST', '/encounters', { name: 'y' });
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('-auto.sqlite'))).toHaveLength(1);
  });

  it('round-trips export -> restore, and an invalid restore leaves data intact', async () => {
    const { call, dir } = await fixture();
    const { snapshot } = await guardEncounter(call);
    const started = await command(call, snapshot.id, snapshot.version, { type: 'START_COMBAT' });
    const withCondition = await command(call, snapshot.id, started.body.snapshot.version, {
      type: 'ADD_CONDITION', combatantId: snapshot.combatants[0].id, conditionKey: 'poisoned', sourceLabel: 'trap',
    });
    const saved = (await call('GET', `/encounters/${snapshot.id}`)).body;
    expect(saved.conditions).toHaveLength(1);

    const exp = await call('GET', '/data/export');
    expect(exp.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(exp.body).toMatchObject({ formatVersion: 1, tables: { templates: [{}], encounters: [{}], conditions: [{}] } });
    expect(exp.body.tables.combatants).toHaveLength(6);
    const preview = await call('POST', '/data/restore/preview', exp.body);
    expect(preview.body.counts).toEqual({ templates: 1, encounters: 1, combatants: 6, conditions: 1 });

    // change things, then restore the export
    await command(call, snapshot.id, withCondition.body.snapshot.version, { type: 'APPLY_DAMAGE', combatantId: snapshot.combatants[0].id, amount: 5 });
    const extra = (await call('POST', '/encounters', { name: 'Extra' })).body;
    const restored = await call('POST', '/data/restore', exp.body);
    expect(restored).toMatchObject({ status: 200, body: { ok: true } });
    expect((await call('GET', `/encounters/${snapshot.id}`)).body).toEqual(saved);
    expect((await call('GET', `/encounters/${extra.id}`)).status).toBe(404);
    expect(readdirSync(join(dir, 'backups')).some((n) => n.endsWith('-pre-restore.sqlite'))).toBe(true);

    // invalid restores are rejected before anything is replaced
    const clone = () => structuredClone(exp.body);
    const badVersion = { ...clone(), formatVersion: 2 };
    const badRef = clone();
    badRef.tables.conditions[0].targetCombatantId = crypto.randomUUID();
    const badHp = clone();
    badHp.tables.combatants[0].currentHp = 999;
    const twoActive = clone();
    twoActive.tables.encounters.push({ ...twoActive.tables.encounters[0], id: crypto.randomUUID() });
    const extraKey = { ...clone(), surprise: true };
    for (const body of [badVersion, badRef, badHp, twoActive, extraKey, { nope: 1 }, []]) {
      const r = await call('POST', '/data/restore', body);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION');
    }
    expect((await call('GET', `/encounters/${snapshot.id}`)).body).toEqual(saved);
    expect((await call('GET', '/templates?archived=0')).body).toHaveLength(1);
  });

  it('rolls back a replace that fails mid-transaction', async () => {
    const { call, db } = await fixture();
    const { snapshot } = await guardEncounter(call);
    const file = validateExport((await call('GET', '/data/export')).body);
    file.tables.combatants[5].currentHp = file.tables.combatants[5].maxHp + 1; // violates a SQL CHECK on insert
    expect(() => replaceAll(db, file)).toThrow();
    expect((await call('GET', `/encounters/${snapshot.id}`)).body).toEqual(snapshot);
  });
});

describe('startup', () => {
  it('refuses a database from a newer schema without touching it', async () => {
    const f = await fixture();
    f.db.$client.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run('future', Date.now() + 1e9);
    f.db.$client.close();
    open.pop();
    await expect(openDb(f.dir)).rejects.toThrow(/newer version/);
  });
});

describe('static files', () => {
  it('serves the built app with SPA fallback but never for /api', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'encounter-dist-'));
    dirs.push(dist);
    writeFileSync(join(dist, 'index.html'), '<html>app</html>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'a.js'), 'console.log(1)');
    const dir = mkdtempSync(join(tmpdir(), 'encounter-test-'));
    dirs.push(dir);
    const db = await openDb(dir);
    open.push(db);
    const app = createApp(db, { dataDir: dir, port: PORT, staticDir: dist, autoBackup: false });
    const get = async (p: string) => {
      const res = await app.request(p, { headers: { Host: `localhost:${PORT}` } });
      return { status: res.status, text: await res.text() };
    };
    expect(await get('/')).toEqual({ status: 200, text: '<html>app</html>' });
    expect(await get('/assets/a.js')).toEqual({ status: 200, text: 'console.log(1)' });
    expect(await get('/encounters/123')).toEqual({ status: 200, text: '<html>app</html>' });
    expect((await get('/api/v1/health')).text).toContain('"ok"');
    expect((await get('/api/v1/nope')).status).toBe(404);
  });
});
