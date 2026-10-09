# Encounter — notes for agents

Local-first D&D 2024 combat manager (single DM, runs on one machine). Built from a PRD/TRD; P0 features only. **Simplicity is the top goal** — prefer the simplest change; no speculative abstractions, tables, or dependencies.

## Layout
- `src/domain/` — pure combat rules, no IO. `encounter.ts` holds `applyCommand` (all state transitions), `hp.ts` the HP math (also used by the UI for previews).
- `src/shared/contract.ts` — Zod schemas + DTO types + endpoint list. Source of truth for the API; change it first, then server and web.
- `src/server/` — Hono + Drizzle on better-sqlite3. `app.ts` routes, `repo.ts` load/save, `backup.ts`, `data.ts` (export/restore), `schema.ts`. Migrations in `drizzle/` (edit schema, run `npm run db:generate`, commit the output).
- `src/web/` — React + Tailwind + hand-written shadcn-style primitives, Zustand store (`store.ts`), hash routing in `App.tsx`.

## Rules to keep
- Every encounter change is one `EncounterCommand` sent to `POST /encounters/:id/commands` with `expectedVersion`; the server applies it in one transaction and returns the snapshot. Stale version → 409. The UI never invents state.
- No command receipts/idempotency, dataset ids, or API token (deliberately cut); security is Host/Origin checks on 127.0.0.1 only.
- Library templates are snapshotted into encounter instances; later template edits never change instances.
- Initiative/turn rules (frozen per-round schedule, Previous Turn checkpoint) live in the PRD §5.4 — keep domain tests in sync with it.

## Commands
`npm test` · `npm run typecheck` · `npm run build && npm start` (http://127.0.0.1:8787) · `npm run dev` (API + Vite on :5173). Env: `PORT`, `ENCOUNTER_DATA_DIR`. Run tests, typecheck, and build before committing.

## UI style
Dark neutral near-black grey (not teal), JetBrains Mono everywhere, one green accent (active/selected/primary), amber for secondary (conditions, temp HP, warnings), red only for 0 HP and save failures. Never rely on colour alone; keep labels, focus rings, and 44px targets. Fonts and assets are bundled locally (works offline).
