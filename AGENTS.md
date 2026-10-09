# Encounter — agent guide

Local-first D&D 2024 combat manager for a single DM on one machine. **Simplicity is the top goal:** implement P0 scope with the smallest coherent change; avoid speculative abstractions, tables, or dependencies.

This is the canonical repository guide for Codex and other coding agents. Keep shared guidance here; `CLAUDE.md` points here. The original PRD/TRD is referenced in comments but is not checked in. Use the code, tests, and `README.md` for available context; request the relevant spec only when a task depends on missing requirements.

## Working approach

- Inspect `git status --short`, the files being changed, and related tests first. Preserve unrelated user changes.
- Follow existing patterns and stay within the requested scope. Resolve routine implementation choices independently; ask when missing requirements would change user-visible behavior or data compatibility.
- Update this guide when commands, boundaries, or invariants change. Keep task plans and transient progress out of permanent agent instructions.
- Leave changes uncommitted unless committing is requested. Report what changed, verification results, and any checks that could not run.

## Setup and commands

Use npm and the checked-in `package-lock.json`. `package.json` requires Node >=20; `better-sqlite3` is a native dependency.

| Purpose | Command / behavior |
| --- | --- |
| Install | `npm ci` |
| Tests | `npm test` (Vitest, one run) |
| Focused tests | `npm test -- src/domain/encounter.test.ts` (substitute the relevant test file) |
| Typecheck | `npm run typecheck` (strict TypeScript, no emit) |
| Build | `npm run build` (Vite builds the web app into `dist/`) |
| Production app | `npm start` (runs the TypeScript server through `tsx`; serves `dist/` if built) |
| Development | `npm run dev` (API on 8787, Vite at `http://127.0.0.1:5173`) |
| Generate migration | `npm run db:generate` |

Run tests, typecheck, and build after code changes and before committing. For guidance-only edits, verify referenced paths, scripts, and `git diff --check`. There is no lint script or browser test suite; do not claim those checks ran. For UI changes, also exercise the affected flow in a browser when available.

## Runtime and local data

- The server binds to `127.0.0.1`, default port 8787. API endpoints are under `/api/v1`; the health check is `GET /api/v1/health`.
- `PORT` changes the API port. Vite's `/api` proxy is hard-coded to 8787 in `vite.config.ts`; setting `PORT` alone does not update the development proxy. Keep Vite on 5173, which the server's Host/Origin allowlist includes.
- `ENCOUNTER_DATA_DIR` selects the directory containing `encounter.sqlite` and `backups/`. Without it, `src/server/db.ts` selects the OS app-data directory.
- For agent-run smoke tests, use a fresh temporary directory, e.g. `ENCOUNTER_DATA_DIR="$(mktemp -d /tmp/encounter-agent-XXXXXX)" npm run dev`. Do not test mutations or restore against the user's default database.

## Code map and change boundaries

- `src/shared/contract.ts`: Zod schemas, inferred types, DTOs, constants, and endpoint list. For API changes, update the contract first, then domain/server/web consumers.
- `src/domain/encounter.ts`: pure state transitions (`applyCommand`), ordering, eligibility, snapshots, and duplication. Inject time, IDs, and template lookup through `Ctx`; keep IO out of the domain.
- `src/domain/hp.ts`: pure HP math and quick-input parsing, shared with UI previews. Reuse it instead of duplicating calculations.
- `src/server/app.ts`: Hono routes and error/security handling. `createApp(db, opts)` does not listen; `index.ts` owns startup and shutdown.
- `src/server/repo.ts`: loads/saves whole encounter state. `schema.ts` defines Drizzle tables and SQL constraints; `db.ts` opens SQLite and applies migrations.
- `src/server/backup.ts` and `data.ts`: backups and strict JSON export/restore validation. Persistent field changes may also need export/restore schema updates.
- `drizzle/`: tracked SQL migrations and metadata. Edit `schema.ts`, generate a new migration, and include the generated files with the change. Do not rewrite applied migrations. Startup applies pending migrations and backs up an existing database before upgrading it.
- `src/web/`: React, Tailwind, Zustand. `api.ts` is the typed fetch wrapper; `store.ts` holds acknowledged snapshots, selection, save status, and drafts. `App.tsx` uses hash routing; `pages/Encounter.tsx` selects Builder for drafts and Tracker otherwise.
- `src/web/components/ui/`: existing hand-written shadcn-style primitives (Radix for dialogs); reuse them and `cn` from `lib/utils.ts`. The `@/` alias resolves to `src/web/`.

## Invariants to preserve

- Each mutation of an existing encounter goes through one `EncounterCommand` to `POST /api/v1/encounters/:id/commands` with `expectedVersion`. The server checks the version, applies the command, and saves in one immediate transaction. A successful command increments the version and returns the authoritative snapshot; stale versions return 409 `VERSION_CONFLICT`.
- The UI commits only acknowledged snapshots. Preserve drafts after failed saves; retry the original command envelope. On a version conflict, refetch and let the DM review before repeating the change. Do not add optimistic encounter updates or blindly replay commands.
- Command receipts/idempotency, dataset IDs, API tokens, multiplayer, and cloud services were deliberately cut. Preserve the loopback bind and Host/Origin checks.
- Library templates are copied into encounter instances. Editing or archiving a template never changes existing instances. Combatant removal uses tombstones for reinstatement.
- At most one encounter is active. Completed encounters accept metadata and archive commands only.
- Each round has a frozen schedule: initiative/tie edits affect the next round. New/reinstated combatants join next round by default; explicit current-round joins use frozen keys and cannot grant a second or retroactive turn.
- Previous Turn restores scheduling only, immediately after Next Turn; any intervening successful mutation clears the checkpoint. It creates a new version rather than undoing arbitrary combat state.
- Damage consumes temp HP first; healing caps at max HP. Draft HP edits update starting values. Conditions retain individual source applications; exhaustion is a separate 0–6 level. Condition effects remain the DM's responsibility.
- Restore validates shape, bounds, and relationships, creates a verified safety backup, then replaces data in one transaction. Preserve rollback and pre-migration backup behavior.

## Tests to extend

- `src/domain/encounter.test.ts`: HP, initiative, scheduling, roster changes, Previous Turn, conditions, lifecycle, and duplication. Use deterministic injected context and check that previous state stays unchanged.
- `src/server/api.test.ts`: real SQLite in temporary directories, Hono `app.request()` without a network listener, persistence/restart, version conflicts, security, backups, restore rollback, and static serving. Follow its fixture cleanup and explicit Host header pattern.
- `src/web/helpers.test.ts`: pure UI helpers. UI previews must agree with domain behavior; use focused regression tests for changed logic.

## UI style

Dark neutral near-black grey (not teal), JetBrains Mono everywhere, green for active/selected/primary, amber for conditions/temp HP/warnings, red only for 0 HP and save failures. Use tokens from `src/web/index.css`. Never rely on colour alone: retain labels, visible focus rings, keyboard access, 44px targets, and save/HP announcements. Bundle fonts and assets locally so the app works offline.
