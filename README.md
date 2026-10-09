# Encounter

Local-first D&D 2024 combat manager. React + Hono + SQLite, runs entirely on your machine.

```
npm ci
npm run build && npm start     # http://127.0.0.1:8787
```

- `npm run dev` — API + Vite dev server (http://127.0.0.1:5173)
- `npm test` / `npm run typecheck`
- `PORT` changes the port; `ENCOUNTER_DATA_DIR` changes where data lives (default: per-OS app-data dir `Encounter/`, containing `encounter.sqlite` and `backups/`).
- Schema change: edit `src/server/schema.ts`, then `npm run db:generate` and commit `drizzle/`.

Backups: Settings → Backup Now (an automatic backup also runs after the first change each day). Settings → Export JSON / Restore for full-dataset portability.

Layout: `src/domain` (pure combat rules), `src/shared/contract.ts` (Zod API contract), `src/server` (Hono + Drizzle), `src/web` (UI). Spec: the PRD/TRD this was built from; MVP cuts are listed below.

MVP cuts vs. the PRD: no command-receipt idempotency (retrying a lost response returns a version conflict and refetches), no dataset-id/token headers (Host/Origin checks only), no Playwright suite, benchmark, or formal accessibility audit.
