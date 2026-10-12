# Concentration

Implements the concentration slice of PRD §15.1. The source PRD/TRD was supplied at `/Users/taylorcollins/Downloads/dnd-2024-combat-manager-prd-trd.md`; this document records the repository's implementation decisions without requiring that local file for future work.

## Behavior

- One active named concentration per caster, with a start timestamp and boundary (acknowledged command version, round, and active combatant). Versions stay monotonic even after Previous Turn.
- Give a condition a **Concentration** duration and select an active caster/spell directly in its Add/Edit dialog. No separate linked-effect creation step is needed. Earlier named effect links remain supported in saved data and API commands; their condition applications still end with concentration. Manual applications remain independent.
- Replacing an existing concentration requires explicit confirmation and ends the old concentration, its linked effects, and pending checks in one command.
- Each positive `APPLY_DAMAGE` creates a distinct pending Constitution-save check. DC is `min(30, max(10, floor(resolved damage / 2)))`: 9 → 10, 25 → 12, 60/100 → 30. Temp HP absorption and current-HP loss do not change this input.
- Success resolves only that check. Failure ends concentration and its linked applications. Manual ending and DM-confirmed death do the same bookkeeping. HP correction, healing, max-HP correction, and zero damage do not prompt saves. Zero HP alone is not a death or Unconscious adjudication.
- Incapacitated, Paralyzed, Petrified, Stunned, and Unconscious prevent concentration and end an existing one. This uses an implication set without adding or deleting unrelated explicit condition rows.
- Caster removal explicitly chooses keep/end. Kept concentration remains manageable, including pending saves, while its caster is removed. Exclusion from turns alone keeps concentration.
- Ending concentration never clears temp HP. The DM corrects feature-specific expiry manually.
- Completed encounters preserve a read-only record, including concentration state. Duplication creates a fresh draft without concentrations/checks; copied conditions become independent applications.

## Persistence and API

Use the existing command envelope, expected-version check, and immediate transaction. Commands are `START_CONCENTRATION`, `END_CONCENTRATION`, `ADD_CONCENTRATION_EFFECT`, and `RESOLVE_CONCENTRATION_CHECK`; `REMOVE_COMBATANT` adds `concentrationPolicy` and `ADD_CONDITION` adds `effectId`.

Active concentration records, nested linked effects, and pending checks are stored in `encounters.concentrations_json`, following the existing whole-state JSON persistence pattern. Condition applications store a nullable `effect_id`. Keeping these encounter-scoped avoids introducing a general effect/duration subsystem just for this feature. Ending a record removes its active effects; there is no historical effects log.

The additive migration defaults existing encounters to `[]` and existing applications to a null link. Export format 1 accepts old files with these fields absent, using the same defaults. Restore checks concentration/effect/check uniqueness, caster and boundary membership, effect ownership, effective Incapacitated, version bounds, and DC correctness before replacement. Startup makes its existing pre-migration backup before upgrading older databases.

Save outcomes are entered manually. Digital dice, combat history/undo, and a persistent dead/alive state remain separate PRD enhancements.
Condition duration/reminder policies are documented in [effects-and-reminders.md](effects-and-reminders.md). The condition form links to the concentration record directly; the original concentration commands and legacy links remain supported.

## Verification

Domain tests cover DC bounds, temp-HP absorption, distinct checks, outcomes, replacement, linked-source cleanup, effective Incapacitated, removal choices, and duplication. API tests cover restart, export/restore, invalid links/DCs/duplicate casters, stale versions, old exports, and migration with an original-schema safety backup. UI announcements cover start, pending saves, success, and ending.
