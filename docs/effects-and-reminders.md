# Condition durations and reminders

Implements PRD §15.2 with the user's refinement: effects are condition applications, with durations managed directly under Conditions. The existing versioned commands and timing engine remain. Internal timers/reminders live in `encounters.timing_json`; condition applications reuse `effect_id`. Existing concentration records and links remain compatible. No new tables, migrations, or dependencies are needed for the condition UI refinement.

## Using the feature

In the builder or tracker, select a combatant → **Conditions** → **Add condition**. Choose the condition, source description/optional creature, notes, and duration together. Each source displays its duration with **Edit duration / source** and **Remove**. Add/edit is one acknowledged command, with no separate effect object to create or link. Remove clears that source's unused timer and obsolete save prompts; other condition sources and temp HP remain. Existing removed targets can still have their condition durations edited or removed.

Duration options:

- **Manual:** remains until removed manually.
- **Next anchor turn:** expires at the selected creature's next turn start/end. A next-turn end waits for a future turn start, so applying it during that creature's current turn never expires it at the current turn end.
- **Fixed rounds:** stores an explicit expiry round and start/end anchor. For whole-round starts, one round means the next round start; for whole-round ends, the current round end is the first future matching boundary. Creature anchors count from their upcoming full turn. The form previews the exact expiry round and anchor before saving.
- **Concentration:** links to a specific active concentration and its caster; it ends with failure, replacement, manual ending, confirmed death, or effective Incapacitated.
- **Save ends:** creates a manual save prompt at this condition's configured target turn start/end. Success removes this source's application; failure keeps it. Other sources of the same condition remain. Older shared timers still resolve per target. Ability and optional DC are descriptive, never automatic roll results.
- **Encounter end:** ends only when combat is completed. Other duration policies preserve their state in the completed, read-only record.

Editing a condition resets only this source's duration from the current boundary. An individual timer keeps its ID and associated custom reminder definitions; outdated save-ends prompts are canceled. Editing an application on an older shared timer splits it off without resetting other applications. Removing all sources of one condition also cleans up those sources' timers, leaving other condition types alone.

Use **Reminders → Add reminder** for independent or condition-associated prompts. Configure turn/round start/end, a one-off or repeat policy, and instructions for a saving throw, ongoing damage, class feature/recharge, or custom note. They create separate persistent occurrences. Acknowledge marks a prompt as seen but keeps it visible; Done or Success/Failure resolves it. Only automatic save-ends prompts remove a condition on success. Dice, damage application, and feature adjustments remain manual. Removing the associated condition stops future reminders and cancels obsolete save-ends prompts; already-triggered custom reminders remain pending for the DM. Disable stops a definition and records its unresolved occurrences as disabled. Resolved history remains visible.

## Boundaries and review

An ordinary advance processes `TURN_END`, then `ROUND_END` and `ROUND_START` if the round changes, then `TURN_START`. Starting combat emits round start followed by the first turn start. Pause/resume of the same active turn generates no extra boundary. Removal/exclusion does not generate a normal turn boundary for the missing participant. Completion emits `ENCOUNTER_END` for selected expiry policies.

Boundary IDs increase monotonically. An occurrence's identity is `(reminder/effect ID, boundary ID, trigger kind)`; processing the same identity again cannot duplicate it. Definition creation versions order work at the same boundary. Automatic expiry only removes linked applications. A custom reminder that fires at the same boundary as its effect's expiry remains pending with an order-adjudication note, regardless of creation order. Already-triggered custom work survives later effect expiry. Suggested damage and save outcomes remain for the DM to adjudicate rather than being applied or discarded silently.

Removed/excluded sources and unavailable creature anchors show **Review required** on the condition. Their creature timers wait; whole-round timers can continue independently. Edit the condition to select a new source/anchor or manual duration, or remove it. To change a reminder anchor, disable and recreate the reminder. Older shared save-ends targets that are unavailable do not prevent prompts for other participating targets.

Next Turn previews expired effects and queued reminders before committing. Previous Turn still reverses scheduling only: it is unavailable after an advance that expires an effect or creates an occurrence, because general combat undo is outside scope. Counter IDs never rewind. A turn start that only arms a future expiry can be reversed safely without restoring conditions or replaying reminders.

## Persistence and verification

The additive migration defaults old encounters to empty timing state and preserves concentration data. Startup backs up existing databases before migration. Export format 1 accepts older files without timing state; restore validates shape, bounds, references, unique identities, effect ownership, and pending/resolved consistency before replacement.

The internal `effects` array and earlier effect commands are retained for data/API compatibility. They are duration records, not a standalone creation flow in the UI. Previously saved timers with no attached conditions appear only in a collapsed **Older saved durations without conditions** cleanup section; timing continues and they can be removed explicitly. Existing condition links display their current duration immediately.

Duplication resets timing definitions and occurrences; copied conditions become independent applications. Domain tests cover boundary order, next-turn and fixed-round expiry, per-target save ends, exclusion/removal, concentration cleanup, occurrence identity, status transitions, and Previous Turn. API tests cover stale versions, restart/export/restore, invalid references, legacy exports, and concentration-era migration with a pre-migration backup.
