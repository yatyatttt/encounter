// The Hono app. createApp(db, opts) builds it without listening, so tests can call app.request().
import { serveStatic } from '@hono/node-server/serve-static';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { applyCommand, duplicateEncounter, newEncounter, toSnapshot } from '../domain/encounter';
import { AppError, type ErrorCode } from '../domain/errors';
import {
  CombatantFields, CommandEnvelope, DuplicateOptions, EncounterStatus, Kind, RULES_VERSION, TemplateInput,
  type ApiError, type Settings, type Template,
} from '../shared/contract';
import { createBackup, latestBackup, maybeAutoBackup } from './backup';
import { exportData, previewOf, replaceAll, validateExport } from './data';
import { schemaVersion } from './db';
import { listEncounters, loadEncounter, loadTemplate, otherActiveName, saveEncounter, templateFields, templateRow, toTemplate, type Db } from './repo';
import { templates } from './schema';

export type AppOptions = {
  dataDir: string;
  port: number;
  appVersion?: string;
  staticDir?: string; // built web app; served with SPA fallback when it contains index.html
  autoBackup?: boolean; // default true
};

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 422 | 503> = {
  VALIDATION: 422, NOT_FOUND: 404, VERSION_CONFLICT: 409, INVALID_STATE: 409, BAD_REQUEST: 400, STORAGE_BUSY: 503, FORBIDDEN: 403,
};
const MiB = 1024 * 1024;
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

const NewEncounter = z.strictObject({ name: z.string().trim().min(1).max(200) });
const TEMPLATE_KEYS = new Set([...Object.keys(CombatantFields.shape), 'tags']);

function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string[]> = {};
  for (const i of r.error.issues) (fieldErrors[i.path.join('.') || '_'] ??= []).push(i.message);
  throw new AppError('VALIDATION', 'Request validation failed', { fieldErrors });
}

async function readJson(c: Context, optional = false): Promise<unknown> {
  const text = await c.req.text();
  if (optional && text.trim() === '') return {};
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new AppError('BAD_REQUEST', 'Content-Type must be application/json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('BAD_REQUEST', 'Malformed JSON');
  }
}

const idParam = (c: Context) => parse(z.uuid(), c.req.param('id'));
const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

export function createApp(db: Db, opts: AppOptions): Hono {
  const app = new Hono();
  const backupDir = join(opts.dataDir, 'backups');
  const appVersion = opts.appVersion ?? '0.1.0';
  // the app's own port plus the Vite dev server (5173), which proxies /api here and forwards its own Host/Origin
  const hosts = new Set([opts.port, 5173].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const now = () => Date.now();
  const json = (c: Context, body: unknown, status: 200 | 201 = 200) => c.json(body as object, status);

  // ---- security ----
  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(HEADERS)) c.res.headers.set(k, v);
  });
  app.use('*', async (c, next) => {
    if (!hosts.has(c.req.header('host') ?? '')) throw new AppError('FORBIDDEN', 'Unrecognized Host header');
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin !== undefined && !origins.has(origin)) {
      throw new AppError('FORBIDDEN', 'Request origin is not allowed');
    }
    await next();
  });
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize: (c.req.path.includes('/data/restore') ? 50 : 1) * MiB,
      onError: (c) => c.json({ error: { code: 'BAD_REQUEST', message: 'Request body too large' } } satisfies ApiError, 413),
    })(c, next),
  );
  // after any successful mutation: maybe take the once-a-day automatic backup (background, never fails the request)
  if (opts.autoBackup !== false) {
    app.use('/api/*', async (c, next) => {
      await next();
      if (c.req.method !== 'GET' && c.res.status < 400) void maybeAutoBackup(db, backupDir);
    });
  }

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...err.extra } } satisfies ApiError, STATUS[err.code]);
    }
    const code = (err as { code?: string }).code ?? '';
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      return c.json({ error: { code: 'STORAGE_BUSY', message: 'The database is busy. Try again in a moment.' } } satisfies ApiError, 503);
    }
    console.error('Unhandled error:', err.name, code, err.message); // no request bodies / notes are logged
    return c.json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } } satisfies ApiError, 500);
  });

  // ---- API ----
  const api = new Hono();

  api.get('/health', (c) => c.json({ status: 'ok', appVersion, rulesVersion: RULES_VERSION }));

  // templates
  api.get('/templates', (c) => {
    const { kind, q, archived } = parse(
      z.object({ kind: Kind.optional(), q: z.string().optional(), archived: z.enum(['0', '1']).default('0') }),
      c.req.query(),
    );
    const needle = q?.trim().toLowerCase();
    const rows = db.select().from(templates).all().map(toTemplate).filter((t) =>
      (!kind || t.kind === kind) &&
      (archived === '1') === (t.archivedAt !== null) &&
      (!needle || [t.name, t.className ?? '', ...t.tags].some((s) => s.toLowerCase().includes(needle))));
    return c.json(rows.sort((a, b) => a.name.localeCompare(b.name)));
  });

  api.post('/templates', async (c) => {
    const input = parse(TemplateInput, await readJson(c));
    const t: Template = { ...input, id: randomUUID(), archivedAt: null, createdAt: now(), updatedAt: now() };
    db.insert(templates).values(templateRow(t)).run();
    return json(c, t, 201);
  });

  api.patch('/templates/:id', async (c) => {
    const id = idParam(c);
    const body = parse(z.record(z.string(), z.unknown()), await readJson(c));
    const unknown = Object.keys(body).filter((k) => !TEMPLATE_KEYS.has(k));
    if (unknown.length) throw new AppError('VALIDATION', 'Unknown fields', { fieldErrors: Object.fromEntries(unknown.map((k) => [k, ['Unknown field']])) });
    const current = loadTemplate(db, id) ?? (() => { throw notFound('Template'); })();
    const { id: _id, archivedAt, createdAt, ...currentInput } = current;
    const t: Template = { ...parse(TemplateInput, { ...currentInput, ...body }), id, archivedAt, createdAt, updatedAt: now() };
    db.update(templates).set(templateRow(t)).where(eq(templates.id, id)).run();
    return c.json(t);
  });

  api.post('/templates/:id/archive', (c) => {
    const id = idParam(c);
    const t = loadTemplate(db, id) ?? (() => { throw notFound('Template'); })();
    const next = { ...t, archivedAt: t.archivedAt ?? now(), updatedAt: now() };
    db.update(templates).set(templateRow(next)).where(eq(templates.id, id)).run();
    return c.json(next);
  });

  api.post('/templates/:id/duplicate', (c) => {
    const t = loadTemplate(db, idParam(c)) ?? (() => { throw notFound('Template'); })();
    const copy = { ...t, id: randomUUID(), name: `${t.name} (copy)`, archivedAt: null, createdAt: now(), updatedAt: now() };
    db.insert(templates).values(templateRow(copy)).run();
    return json(c, copy, 201);
  });

  // encounters
  api.get('/encounters', (c) => {
    const { status, archived } = parse(z.object({ status: EncounterStatus.optional(), archived: z.enum(['0', '1']).default('0') }), c.req.query());
    return c.json(listEncounters(db, status, archived === '1'));
  });

  api.post('/encounters', async (c) => {
    const { name } = parse(NewEncounter, await readJson(c));
    const state = newEncounter(name, { now: now(), newId: randomUUID });
    db.transaction((tx) => saveEncounter(tx, state), { behavior: 'immediate' });
    return json(c, toSnapshot(state), 201);
  });

  api.get('/encounters/:id', (c) => {
    const state = loadEncounter(db, idParam(c)) ?? (() => { throw notFound('Encounter'); })();
    return c.json(toSnapshot(state));
  });

  api.post('/encounters/:id/duplicate', async (c) => {
    const id = idParam(c);
    const opt = parse(DuplicateOptions, await readJson(c, true));
    const copy = db.transaction((tx) => {
      const src = loadEncounter(tx, id) ?? (() => { throw notFound('Encounter'); })();
      const dup = duplicateEncounter(src, opt, { now: now(), newId: randomUUID });
      saveEncounter(tx, dup);
      return dup;
    }, { behavior: 'immediate' });
    return json(c, toSnapshot(copy), 201);
  });

  api.post('/encounters/:id/commands', async (c) => {
    const id = idParam(c);
    const { expectedVersion, command } = parse(CommandEnvelope, await readJson(c));
    const result = db.transaction((tx) => {
      const state = loadEncounter(tx, id) ?? (() => { throw notFound('Encounter'); })();
      if (state.version !== expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 'This encounter changed since you loaded it', { currentVersion: state.version });
      }
      const { state: next, affectedIds } = applyCommand(state, command, {
        now: now(), newId: randomUUID, template: (tid) => templateFields(tx, tid), otherActive: otherActiveName(tx, id),
      });
      saveEncounter(tx, next);
      return { snapshot: toSnapshot(next), affectedIds };
    }, { behavior: 'immediate' });
    return c.json(result);
  });

  // settings / data
  api.get('/settings', (c) => {
    const settings: Settings = {
      appVersion, rulesVersion: RULES_VERSION, schemaVersion: schemaVersion(db),
      dataDir: opts.dataDir, backupDir, latestBackup: latestBackup(backupDir),
    };
    return c.json(settings);
  });

  api.post('/data/backups', async (c) => c.json(await createBackup(db.$client, backupDir, 'manual')));

  api.get('/data/export', (c) => {
    const file = exportData(db, appVersion);
    c.header('Content-Disposition', `attachment; filename="encounter-export-${new Date(file.exportedAt).toISOString().slice(0, 10)}.json"`);
    return c.json(file);
  });

  api.post('/data/restore/preview', async (c) => c.json(previewOf(validateExport(await readJson(c)))));

  api.post('/data/restore', async (c) => {
    const file = validateExport(await readJson(c));
    await createBackup(db.$client, backupDir, 'pre-restore'); // safety copy before anything is replaced
    replaceAll(db, file);
    return c.json({ ok: true });
  });

  api.all('*', () => { throw notFound('Route'); });
  app.route('/api/v1', api);
  app.all('/api/*', () => { throw notFound('Route'); });

  // ---- built web app (production) ----
  if (opts.staticDir && existsSync(join(opts.staticDir, 'index.html'))) {
    const root = relative(process.cwd(), opts.staticDir) || '.';
    app.use('*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' })); // SPA fallback
  }
  return app;
}
