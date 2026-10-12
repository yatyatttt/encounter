// API + persistence tests: real SQLite in a temp dir, requests via app.request() (no network).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Db } from './repo';
import type { Template, TimingDto } from '../shared/contract';
import { createApp } from './app';
import { replaceAll, validateExport } from './data';
import { openDb } from './db';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

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
  it('persists condition-owned durations, supports atomic edits/removal, and preserves older condition sources', async () => {
    const f = await fixture();
    let s = (await guardEncounter(f.call, 'Conditions', 2)).snapshot;
    const [source, target] = s.combatants;
    const add = { type: 'ADD_CONDITION', combatantId: target.id, conditionKey: 'poisoned', sourceCombatantId: source.id, sourceLabel: 'Spell', notes: '', duration: { kind: 'save-ends', phase: 'start', ability: 'constitution', dc: 13 } };
    let r = await command(f.call, s.id, s.version, add);
    expect(r.status).toBe(200);
    expect((await command(f.call, s.id, s.version, add)).status).toBe(409);
    s = r.body.snapshot;
    const condition = s.conditions[0];
    expect(condition.effectId).toBe(s.timing.effects[0].id);
    r = await command(f.call, s.id, s.version, { type: 'ADD_CONDITION', combatantId: target.id, conditionKey: 'poisoned', sourceLabel: 'Trap' });
    s = r.body.snapshot;
    r = await command(f.call, s.id, s.version, { type: 'CREATE_REMINDER', reminder: { name: 'Poison damage', notes: 'Roll manually', kind: 'damage', repeat: true, effectId: condition.effectId, trigger: { kind: 'turn', anchorCombatantId: target.id, phase: 'start' } } });
    s = r.body.snapshot;
    s = (await command(f.call, s.id, s.version, { type: 'START_COMBAT' })).body.snapshot;
    s = (await command(f.call, s.id, s.version, { type: 'NEXT_TURN' })).body.snapshot;
    expect(s.timing.occurrences).toHaveLength(2);
    r = await command(f.call, s.id, s.version, { type: 'UPDATE_CONDITION', applicationId: condition.id, sourceCombatantId: null, sourceLabel: 'Spell', notes: 'Kept by DM', duration: { kind: 'manual' } });
    expect(r.status).toBe(200);
    s = r.body.snapshot;
    expect(s.conditions[0]).toMatchObject({ id: condition.id, effectId: condition.effectId, notes: 'Kept by DM' });
    expect(s.timing.occurrences.map((o: { status: string }) => o.status)).toEqual(['resolved', 'pending']);
    const file = (await f.call('GET', '/data/export')).body;
    f.db.$client.close(); open.splice(open.indexOf(f.db), 1);
    const restarted = await fixture(f.dir);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body.conditions).toEqual(s.conditions);
    expect((await restarted.call('POST', '/data/restore', file)).status).toBe(200);
    const bad = await command(restarted.call, s.id, s.version, { type: 'UPDATE_CONDITION', applicationId: condition.id, sourceCombatantId: null, sourceLabel: '', notes: '', duration: { kind: 'next-turn', anchorCombatantId: crypto.randomUUID(), phase: 'end' } });
    expect(bad.status).toBe(404);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    r = await command(restarted.call, s.id, s.version, { type: 'REMOVE_CONDITION', applicationId: condition.id });
    expect(r.status).toBe(200);
    expect(r.body.snapshot.conditions.map((c: { sourceLabel: string }) => c.sourceLabel)).toEqual(['Trap']);
    expect(r.body.snapshot.timing.effects).toEqual([]);
    expect(r.body.snapshot.timing.reminders[0].enabled).toBe(false);
    expect((await restarted.call('POST', '/data/restore', (await restarted.call('GET', '/data/export')).body)).status).toBe(200);
  });

  it('persists durations and acknowledged reminders across restart/restore, and rejects duplicate or invalid timing references', async () => {
    const f = await fixture();
    let { snapshot: s } = await guardEncounter(f.call, 'Effects', 2);
    const source = s.combatants[0].id, target = s.combatants[1].id;
    const act = async (cmd: object) => {
      const r = await command(f.call, s.id, s.version, cmd);
      expect(r.status).toBe(200);
      s = r.body.snapshot;
    };
    await act({ type: 'START_COMBAT' });
    await act({ type: 'CREATE_EFFECT', effect: { name: 'Burning', sourceCombatantId: source, targetCombatantIds: [target], duration: { kind: 'next-turn', anchorCombatantId: target, phase: 'end' } } });
    const effectId = s.timing.effects[0].id;
    await act({ type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', effectId, sourceLabel: 'Burning' });
    await act({ type: 'ADD_CONDITION', combatantId: target, conditionKey: 'poisoned', sourceLabel: 'Trap' });
    await act({ type: 'CREATE_REMINDER', reminder: { name: 'Roll fire damage', notes: '1d6 manually', kind: 'damage', trigger: { kind: 'turn', anchorCombatantId: target, phase: 'start' }, repeat: true, effectId } });
    await act({ type: 'NEXT_TURN' });
    await act({ type: 'ACKNOWLEDGE_REMINDER', occurrenceId: s.timing.occurrences[0].id });
    expect(s.timing.occurrences[0].status).toBe('acknowledged');
    expect(s.combatants[1].currentHp).toBe(11); // reminder never applies damage
    const file = (await f.call('GET', '/data/export')).body;
    f.db.$client.close(); open.pop();
    const restarted = await fixture(f.dir);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    expect((await restarted.call('POST', '/data/restore', file)).status).toBe(200);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    const stale = await command(restarted.call, s.id, s.version - 1, { type: 'NEXT_TURN' });
    expect(stale.status).toBe(409);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    for (const mutate of [
      (t: TimingDto) => { if (t.effects[0].duration.kind === 'next-turn') t.effects[0].duration.anchorCombatantId = crypto.randomUUID(); },
      (t: TimingDto) => { t.effects[0].createdBoundaryId = t.boundaryId + 1; },
      (t: TimingDto) => { t.occurrences.push({ ...t.occurrences[0], id: crypto.randomUUID() }); },
      (t: TimingDto) => { t.reminders[0].effectId = crypto.randomUUID(); },
      (t: TimingDto) => { t.occurrences[0].status = 'resolved'; },
      (t: TimingDto) => { t.occurrences[0].kind = 'saving-throw'; },
      (t: TimingDto) => { const copy = { ...t.effects[0], id: crypto.randomUUID() }; t.effects.push(copy); t.occurrences[0].effectId = copy.id; },
    ]) {
      const bad = structuredClone(file), timing = JSON.parse(bad.tables.encounters[0].timingJson);
      mutate(timing); bad.tables.encounters[0].timingJson = JSON.stringify(timing);
      expect((await restarted.call('POST', '/data/restore', bad)).status).toBe(422);
    }
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    const ended = await command(restarted.call, s.id, s.version, { type: 'NEXT_TURN' });
    expect(ended.body.snapshot.timing.effects).toEqual([]);
    expect(ended.body.snapshot.timing.occurrences[0]).toMatchObject({ status: 'acknowledged', outcome: null });
    expect(ended.body.snapshot.conditions.map((c: { sourceLabel: string }) => c.sourceLabel)).toEqual(['Trap']);
    const endedFile = (await restarted.call('GET', '/data/export')).body;
    expect((await restarted.call('POST', '/data/restore', endedFile)).status).toBe(200);
  });

  it('persists concentration checks and effect links across restart/export/restore, validating references', async () => {
    const f = await fixture();
    let { snapshot: s } = await guardEncounter(f.call, 'Concentration', 2);
    const casterId = s.combatants[0].id;
    const targetId = s.combatants[1].id;
    const act = async (cmd: object) => {
      const r = await command(f.call, s.id, s.version, cmd);
      expect(r.status).toBe(200);
      s = r.body.snapshot;
    };
    await act({ type: 'START_CONCENTRATION', combatantId: casterId, name: 'Hold Person' });
    const conc = s.concentrations[0];
    await act({ type: 'ADD_CONDITION', combatantId: targetId, conditionKey: 'paralyzed', sourceLabel: 'Hold Person', effectId: conc.linkedEffects[0].id });
    await act({ type: 'SET_TEMP_HP', combatantId: casterId, value: 40 });
    await act({ type: 'APPLY_DAMAGE', combatantId: casterId, amount: 25 });
    const exportFile = (await f.call('GET', '/data/export')).body;
    expect(s.concentrations[0].checks).toMatchObject([{ damage: 25, dc: 12 }]);

    f.db.$client.close();
    open.pop();
    const restarted = await fixture(f.dir);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    expect((await restarted.call('POST', '/data/restore', exportFile)).status).toBe(200);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    const stale = await command(restarted.call, s.id, s.version - 1, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: conc.id, checkId: s.concentrations[0].checks[0].id, outcome: 'failure' });
    expect(stale.status).toBe(409);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);

    const badLink = structuredClone(exportFile);
    badLink.tables.conditions[0].effectId = crypto.randomUUID();
    const duplicateCaster = structuredClone(exportFile);
    const cs = JSON.parse(duplicateCaster.tables.encounters[0].concentrationsJson);
    duplicateCaster.tables.encounters[0].concentrationsJson = JSON.stringify([...cs, { ...cs[0], id: crypto.randomUUID() }]);
    const badDc = structuredClone(exportFile);
    const dcState = JSON.parse(badDc.tables.encounters[0].concentrationsJson);
    dcState[0].checks[0].dc = 11;
    badDc.tables.encounters[0].concentrationsJson = JSON.stringify(dcState);
    for (const bad of [badLink, duplicateCaster, badDc]) expect((await restarted.call('POST', '/data/restore', bad)).status).toBe(422);
    expect((await restarted.call('GET', `/encounters/${s.id}`)).body).toEqual(s);

    const ended = await command(restarted.call, s.id, s.version, { type: 'RESOLVE_CONCENTRATION_CHECK', concentrationId: conc.id, checkId: s.concentrations[0].checks[0].id, outcome: 'failure' });
    expect(ended.body.snapshot.concentrations).toEqual([]);
    expect(ended.body.snapshot.conditions).toEqual([]);
    expect(ended.body.snapshot.combatants[0].tempHp).toBe(15);
  });

  it('restores pre-concentration exports with empty concentration state and manual condition links', async () => {
    const { call } = await fixture();
    const { snapshot } = await guardEncounter(call, 'Legacy export', 1);
    await command(call, snapshot.id, snapshot.version, { type: 'ADD_CONDITION', combatantId: snapshot.combatants[0].id, conditionKey: 'poisoned', sourceLabel: 'Trap' });
    const legacy = (await call('GET', '/data/export')).body;
    for (const row of legacy.tables.encounters) delete row.concentrationsJson;
    for (const row of legacy.tables.encounters) delete row.timingJson;
    for (const row of legacy.tables.conditions) delete row.effectId;
    expect((await call('POST', '/data/restore', legacy)).status).toBe(200);
    const restored = (await call('GET', `/encounters/${snapshot.id}`)).body;
    expect(restored.concentrations).toEqual([]);
    expect(restored.timing).toMatchObject({ boundaryId: 0, effects: [], reminders: [], occurrences: [] });
    expect(restored.conditions).toMatchObject([{ effectId: null }]);
  });

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
  it('upgrades a concentration database without losing concentration checks or its original-schema backup', async () => {
    const current = await fixture();
    let { snapshot: s } = await guardEncounter(current.call, 'Existing concentration', 1);
    let r = await command(current.call, s.id, s.version, { type: 'START_CONCENTRATION', combatantId: s.combatants[0].id, name: 'Bless' });
    r = await command(current.call, s.id, r.body.snapshot.version, { type: 'APPLY_DAMAGE', combatantId: s.combatants[0].id, amount: 2 });
    s = r.body.snapshot;
    const dir = mkdtempSync(join(tmpdir(), 'encounter-timing-upgrade-'));
    const migrations = mkdtempSync(join(tmpdir(), 'encounter-timing-migrations-'));
    dirs.push(dir, migrations);
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 2);
    mkdirSync(join(migrations, 'meta'));
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) writeFileSync(join(migrations, `${entry.tag}.sql`), readFileSync(join('drizzle', `${entry.tag}.sql`)));
    const old = new Database(join(dir, 'encounter.sqlite'));
    try {
      migrate(drizzle(old), { migrationsFolder: migrations });
      old.prepare('attach database ? as modern').run(join(current.dir, 'encounter.sqlite'));
      for (const table of ['combatant_templates', 'encounters', 'encounter_combatants', 'condition_applications']) {
        const columns = (old.pragma(`table_info(${table})`) as { name: string }[]).map((c) => `"${c.name}"`).join(',');
        old.exec(`insert into ${table} (${columns}) select ${columns} from modern.${table}`);
      }
    } finally { old.close(); }
    const upgraded = await fixture(dir);
    expect((await upgraded.call('GET', `/encounters/${s.id}`)).body).toEqual(s);
    const backup = readdirSync(join(dir, 'backups')).find((n) => n.endsWith('-pre-migration.sqlite'))!;
    const original = new Database(join(dir, 'backups', backup), { readonly: true });
    try {
      expect(original.pragma('table_info(encounters)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'timing_json' })]));
      expect(JSON.parse((original.prepare('select concentrations_json from encounters').get() as { concentrations_json: string }).concentrations_json)).toEqual(s.concentrations);
    } finally { original.close(); }
  });

  it('upgrades a pre-concentration database and backs up the original before migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'encounter-legacy-'));
    const migrations = mkdtempSync(join(tmpdir(), 'encounter-legacy-migrations-'));
    dirs.push(dir, migrations);
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    journal.entries = journal.entries.slice(0, 1);
    mkdirSync(join(migrations, 'meta'));
    writeFileSync(join(migrations, 'meta/_journal.json'), JSON.stringify(journal));
    const filename = `${journal.entries[0].tag}.sql`;
    writeFileSync(join(migrations, filename), readFileSync(join('drizzle', filename)));
    const sqlite = new Database(join(dir, 'encounter.sqlite'));
    const id = crypto.randomUUID();
    try {
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      sqlite.prepare(`insert into encounters (id, name, status, round, schedule_json, rules_version, version, created_at, updated_at)
        values (?, 'Legacy draft', 'draft', 0, ?, 'dnd-2024-manual-v1', 1, 1000, 1000)`).run(id, JSON.stringify({ pendingIds: [], actedIds: [], orderKeys: {} }));
    } finally { sqlite.close(); }

    const f = await fixture(dir);
    expect((await f.call('GET', `/encounters/${id}`)).body).toMatchObject({ name: 'Legacy draft', version: 1, concentrations: [] });
    const backup = readdirSync(join(dir, 'backups')).find((name) => name.endsWith('-pre-migration.sqlite'))!;
    expect(backup).toBeTruthy();
    const original = new Database(join(dir, 'backups', backup), { readonly: true });
    try {
      expect(original.prepare('select name from encounters where id = ?').get(id)).toEqual({ name: 'Legacy draft' });
      expect(original.pragma('table_info(encounters)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'concentrations_json' })]));
    } finally { original.close(); }
  });

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
