# Encounter

Local-first D&D 2024 combat manager for a single DM on one machine. Prepare reusable combatants, build encounters, and track initiative, HP, conditions, concentration, and reminders. React + Hono + SQLite; data stays on your machine, with no account or cloud service required. Fonts and assets are bundled locally for offline use after installation.

## Install and run

Requires **Node.js 20 or newer** and npm. Run these commands from the repository directory:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:8787** in your browser. Keep the terminal running while using the app; press `Ctrl+C` to stop it. Saved data remains available when you start it again. After updating the source, rebuild with `npm run build` before restarting.

For development, run `npm run dev` and open **http://127.0.0.1:5173**. This starts the API on port 8787 and the Vite frontend on port 5173.

## How to use Encounter

### 1. Prepare your combatant library

Open **Library → + New Template** to save a player, enemy, or NPC with its HP, AC, initiative modifier, speed, and other details. Search by name or tag and filter by kind. Use **Edit** to update a template or **Duplicate** to make a variant.

Templates are reusable starting points. Adding one to an encounter creates an independent copy: later library edits, archiving, or unarchiving never change combatants already in encounters. You can also skip the library and add ad hoc combatants directly.

### 2. Build an encounter

1. On the **Dashboard**, click **+ New Encounter**, enter a name, and choose **Create & open builder**.
2. Add notes or objectives and click **Save details**.
3. Click **+ Add combatant**. Choose a **Library template** or **Ad hoc**, fill in the details, and click **Add**. Quantity creates separate combatants with their own HP and numbered names.
4. Enter initiative in **Total** mode (the final total, with no modifier added) or **Roll** mode (a d20 result from 1–20, with the combatant's modifier added). Click **Apply initiative**. For a group sharing one total, select its checkboxes and use **Set shared**.
5. Adjust tied initiative using the tie-order controls. Select a combatant's name to edit its **Starting stats** and conditions.
6. Click **Start Combat**. Combatants without initiative are not scheduled; check the builder's warning before starting.

Only one encounter can be active at a time. Pause or finish it before starting another.

### 3. Run combat

The tracker shows the active combatant, the next combatant, and the round. Select a combatant in the initiative table to open its detail panel.

- **Next Turn** advances the schedule and processes condition expiry and reminders. The `N` shortcut works when you are not typing or using a dialog and no save is pending.
- **Previous Turn** reverses scheduling immediately after an ordinary advance. It does not undo HP or other combat changes. Any intervening saved change, or an advance that expires conditions or creates reminders, makes it unavailable.
- **Pause** stops turn advancement while allowing corrections. **Resume** continues combat.
- **Turn policy** controls whether a combatant follows the encounter's HP policy, is always included, or is excluded. The builder also has a **Skip zero-HP enemies when scheduling turns** option.

The current round's order is frozen. Initiative and tie-order edits affect the next round.

### 4. Change HP and stats

Select the combatant, enter a value in **HP entry**, review the preview, and click **Apply**:

| Input | Action |
| --- | --- |
| `-12` | Apply 12 damage, consuming temporary HP first |
| `+8` | Heal 8 HP, capped at max HP |
| `15` | Set current HP to 15 as a correction |

Use **Grant temp HP** to add temporary HP; pools do not stack, and the form previews how an existing pool will be handled.

To change a player's maximum HP after adding them, select their name, expand **Corrections**, enter **Max HP**, and click **Set**. Increasing max HP leaves current HP unchanged; decreasing it clamps current HP if necessary. **Corrections** also contains other editable stats and a temporary HP correction. In a draft, the corresponding section is **Starting stats**, and HP edits define starting values.

### 5. Add or remove combatants during combat

Click **+ Add Combatant** below the initiative table during active or paused combat. Choose a library template or ad hoc entry, enter initiative, and choose when it joins:

- **Next round** is the default; its first turn is in the next round.
- **Remaining current round** inserts it by initiative among those still to act, after the active turn.

To remove someone, select them and use **Remove** in the detail panel. Removed combatants remain under **Removed / excluded** and can be reinstated. Reinstatement lets you choose the join timing and never grants a second turn to someone who already acted that round. Removing the active combatant during running combat advances to the next participant.

### 6. Track conditions, concentration, and reminders

**Conditions:** Select a combatant → **Conditions → Add condition**. Choose its source and a manual, next-turn, fixed-round, concentration, save-ends, or encounter-end duration in the same form. Each source has its own duration and **Edit/Remove** controls. Expiring or removing one source preserves other sources of the same condition. Exhaustion is tracked separately as a level from 0–6.

**Concentration:** Start concentration with a spell or effect name in the selected combatant's detail panel. Positive damage creates separate Constitution-save prompts, including damage absorbed by temporary HP. Record **Success** or **Failure** in the concentration-check panel. The DC is `min(30, max(10, floor(damage / 2)))`. HP corrections and healing do not create checks; reaching 0 HP alone does not confirm death.

Give a condition a **Concentration** duration to link it to the caster. Replacing or ending concentration, failing a check, confirming death, or becoming Incapacitated ends linked condition applications while preserving unrelated sources and temporary HP. Removing a caster asks whether to keep or end concentration.

**Reminders:** Use **Add reminder** in the Reminders section for one-off or recurring turn/round prompts for saves, ongoing damage, features, or notes. Acknowledge a prompt or record **Done**, **Success**, or **Failure** as appropriate. Reminders prompt you to act; they do not automatically apply damage or decide outcomes. Pending reminders persist across turns and reloads. Review warnings identify removed or excluded sources and timing anchors that need attention.

See [concentration behavior](docs/concentration.md) and [condition duration and reminder behavior](docs/effects-and-reminders.md) for detailed rules. Other condition effects remain the DM's responsibility.

### 7. Finish, reuse, and archive

Use **End Combat** to keep a completed record. Combat details become read-only; unresolved reminders remain visible. **Duplicate** creates a new draft from an existing encounter, using either starting or current HP/temp HP, with an option to copy manual conditions.

Archiving keeps old or unused items out of everyday lists without deleting their data:

| Item | Archive | View and restore |
| --- | --- | --- |
| Encounter | Click **Archive** on the Dashboard. Active combat must be paused or completed first. | Check **Show archived** on the Dashboard. Open an encounter to inspect it, or click **Unarchive** to return it to the normal list. |
| Library template | Click **Archive** in the Library. It is also hidden from add-combatant searches. | Check **Show archived** in the Library, then click **Unarchive** to make it available again. |

**Show archived** switches to archived items only. Uncheck it to return to normal items. Unarchiving preserves contents and encounter status: a completed encounter stays completed, and a paused encounter stays paused. Archived items remain in local storage, backups, and JSON exports.

### Saving and recovery

Changes are saved when you apply an action; typing into a field alone does not save it. Check **SAVED**, **SAVING…**, or **SAVE FAILED** in the encounter header. Failed saves retain typed input and offer **Retry**. If a version conflict occurs, the app reloads the saved encounter so you can review it before repeating the change.

## Data, backups, and restore

Open **Settings** to see the data folder, backup folder, latest backup, and app/rules/schema versions.

- **Backup now** creates a local database backup. An automatic backup also runs after the first successful mutation each day.
- **Export JSON** downloads the full dataset for portability. Keep a copy elsewhere if you want protection against losing this machine.
- **Restore from JSON** validates an export, previews its contents, and asks for confirmation. Restore replaces the entire dataset rather than merging it. A verified safety backup is created first; failed restores roll back. Pause or finish running combat before restoring.
- Startup applies pending database migrations and backs up an existing database before upgrading it.

Default data locations contain `encounter.sqlite` and a `backups/` folder:

| OS | Default folder |
| --- | --- |
| macOS | `~/Library/Application Support/Encounter` |
| Windows | `%APPDATA%\Encounter` (falls back to the user's `AppData\Roaming\Encounter`) |
| Linux | `$XDG_DATA_HOME/Encounter`, or `~/.local/share/Encounter` |

`ENCOUNTER_DATA_DIR` selects a different data folder. `PORT` changes the API/production app port, which defaults to 8787. The server binds to `127.0.0.1` for use on this machine. In development, Vite's `/api/` proxy is fixed to port 8787; changing `PORT` alone does not update it. Keep the development frontend on 5173, which the server's Host/Origin checks allow.

## Development

Use npm and the checked-in `package-lock.json`. `better-sqlite3` is a native dependency.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies |
| `npm run dev` | Run the API and Vite development server |
| `npm test` | Run the Vitest suite once |
| `npm test -- src/domain/encounter.test.ts` | Run a focused test file |
| `npm run typecheck` | Check strict TypeScript types without emitting files |
| `npm run build` | Build the web app into `dist/` |
| `npm start` | Run the server and serve the built app |
| `npm run db:generate` | Generate a migration after editing `src/server/schema.ts` |

Include generated `drizzle/` files with schema changes; do not rewrite applied migrations. For smoke tests that mutate data, use a fresh temporary data directory rather than your normal database:

```sh
ENCOUNTER_DATA_DIR="$(mktemp -d /tmp/encounter-agent-XXXXXX)" npm run dev
```

Code layout: `src/domain/` contains pure combat rules; `src/shared/contract.ts` defines the Zod API contract; `src/server/` contains Hono routes, Drizzle persistence, and backups; `src/web/` contains the React UI. See [AGENTS.md](AGENTS.md) for repository conventions and invariants.

Current scope is P0 plus concentration and condition durations/reminders. Deliberate limits include no multiplayer or cloud sync, command-receipt idempotency, dataset-ID/token headers, Playwright suite, benchmark, or formal accessibility audit. Requests use loopback binding and Host/Origin checks. A retry after a lost successful response produces a version conflict and refetch rather than silently replaying the change.
