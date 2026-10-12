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

Concentration: select a combatant and enter a spell/effect name in the details panel. Positive damage adds a separate Constitution-save prompt using the 2024 DC (10–30), including damage absorbed by temp HP. Record Success or Failure in the concentration-check panel. Give a condition a Concentration duration to end it with that caster's concentration. Replacing concentration, a failed check, manual ending, confirmed death, or an Incapacitated condition ends its linked applications; independent sources and temp HP remain. Removing a caster asks whether to keep or end concentration. See [concentration behavior](docs/concentration.md).

Condition durations & reminders: select a combatant → Conditions → Add condition, then choose a manual, next-turn, fixed-round, concentration, save-ends, or encounter-end duration in the same form. Each source shows its duration and has Edit/Remove controls; automatic expiry and manual removal preserve other sources of the same condition. The form and Next Turn show expiry previews. Add one-off or recurring turn/round reminders for saves, ongoing damage, features, or notes; acknowledge them or record an outcome manually. Pending reminders persist across turns and reloads. Removed/excluded sources and anchors are flagged for review. See [duration and reminder behavior](docs/effects-and-reminders.md).

Layout: `src/domain` (pure combat rules), `src/shared/contract.ts` (Zod API contract), `src/server` (Hono + Drizzle), `src/web` (UI). Spec: the PRD/TRD this was built from; MVP cuts are listed below.

MVP cuts vs. the PRD: no command-receipt idempotency (retrying a lost response returns a version conflict and refetches), no dataset-id/token headers (Host/Origin checks only), no Playwright suite, benchmark, or formal accessibility audit.
