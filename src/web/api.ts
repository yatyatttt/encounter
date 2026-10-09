// One small typed fetch wrapper for the local REST API (see src/shared/contract.ts).
import type {
  ApiError, BackupInfo, CommandEnvelope, CommandResponse, DuplicateOptions, EncounterSnapshot, EncounterStatus,
  EncounterSummary, ExportFile, RestorePreview, Settings, Template, TemplateInput,
} from '../shared/contract';

export const UNREACHABLE = 'Local server not reachable — is `npm start` running?';

/** An API error response (code/message from the server) or a network failure (code NETWORK). */
export class ApiFailure extends Error {
  constructor(public code: string, message: string, public fieldErrors?: Record<string, string[]>, public currentVersion?: number) {
    super(message);
  }
  get unreachable() { return this.code === 'NETWORK'; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure('NETWORK', UNREACHABLE);
  }
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const e = (json as ApiError | undefined)?.error;
    // A proxy with no backend (vite dev) answers 5xx with a non-API body: treat as unreachable.
    if (!e) throw new ApiFailure(res.status >= 500 ? 'NETWORK' : 'HTTP', res.status >= 500 ? UNREACHABLE : `Unexpected response (HTTP ${res.status}).`);
    throw new ApiFailure(e.code, e.message, e.fieldErrors, e.currentVersion);
  }
  return json as T;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => request<unknown>('GET', '/health'),
  templates: (q: { kind?: string; q?: string; archived?: boolean }) =>
    request<Template[]>('GET', `/templates${qs({ kind: q.kind, q: q.q, archived: q.archived ? '1' : '0' })}`),
  createTemplate: (t: unknown) => request<Template>('POST', '/templates', t as TemplateInput),
  updateTemplate: (id: string, t: unknown) => request<Template>('PATCH', `/templates/${id}`, t),
  archiveTemplate: (id: string) => request<Template>('POST', `/templates/${id}/archive`),
  duplicateTemplate: (id: string) => request<Template>('POST', `/templates/${id}/duplicate`),
  encounters: (q: { status?: EncounterStatus; archived?: boolean } = {}) =>
    request<EncounterSummary[]>('GET', `/encounters${qs({ status: q.status, archived: q.archived ? '1' : '0' })}`),
  createEncounter: (name: string) => request<EncounterSnapshot>('POST', '/encounters', { name }),
  encounter: (id: string) => request<EncounterSnapshot>('GET', `/encounters/${id}`),
  duplicateEncounter: (id: string, o: DuplicateOptions) => request<EncounterSnapshot>('POST', `/encounters/${id}/duplicate`, o),
  command: (id: string, env: CommandEnvelope) => request<CommandResponse>('POST', `/encounters/${id}/commands`, env),
  settings: () => request<Settings>('GET', '/settings'),
  backup: () => request<BackupInfo>('POST', '/data/backups'),
  exportData: () => request<ExportFile>('GET', '/data/export'),
  restorePreview: (f: ExportFile) => request<RestorePreview>('POST', '/data/restore/preview', f),
  restore: (f: ExportFile) => request<{ ok: true }>('POST', '/data/restore', f),
};

/** Look up an inline error for a field name in a Zod-style fieldErrors map (keys may be nested paths). */
export function fieldError(errors: Record<string, string[]> | undefined | null, name: string): string | undefined {
  if (!errors) return undefined;
  const k = Object.keys(errors).find((key) => key === name || key.endsWith(`.${name}`));
  return k ? errors[k].join('; ') : undefined;
}
