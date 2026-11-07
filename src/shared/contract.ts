// Shared API contract: Zod schemas + inferred types. Used by server (validation) and web (types).
//
// REST endpoints (all JSON, base path /api/v1; errors: { error: { code, message, fieldErrors?, currentVersion? } }):
//   GET    /health
//   GET    /templates?kind=&q=&archived=0|1            -> Template[]
//   POST   /templates            body TemplateInput     -> Template
//   PATCH  /templates/:id        body Partial<TemplateInput> -> Template
//   POST   /templates/:id/unarchive                      -> Template
//   POST   /templates/:id/archive                        -> Template
//   POST   /templates/:id/duplicate                      -> Template
//   GET    /encounters?status=&archived=0|1              -> EncounterSummary[]
//   POST   /encounters           body { name }           -> EncounterSnapshot (draft)
//   GET    /encounters/:id                               -> EncounterSnapshot
//   POST   /encounters/:id/duplicate body DuplicateOptions -> EncounterSnapshot (new draft)
//   POST   /encounters/:id/commands body CommandEnvelope -> { snapshot: EncounterSnapshot, affectedIds: string[] }
//   GET    /settings                                     -> Settings
//   POST   /data/backups                                 -> BackupInfo
//   GET    /data/export                                  -> ExportFile (download)
//   POST   /data/restore/preview body ExportFile         -> RestorePreview
//   POST   /data/restore         body ExportFile         -> { ok: true }  (safety backup first, then replace)
//
// Error codes: VALIDATION (422), NOT_FOUND (404), VERSION_CONFLICT (409, includes currentVersion),
// INVALID_STATE (409, lifecycle/other domain rule violated), BAD_REQUEST (400), STORAGE_BUSY (503), INTERNAL (500).
import { z } from 'zod';

// ---------- constants ----------
export const CONDITION_KEYS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
] as const; // 14 ordinary conditions; Exhaustion (the 15th) is a level on the combatant
export const ConditionKey = z.enum(CONDITION_KEYS);
export type ConditionKey = z.infer<typeof ConditionKey>;

export const RULES_VERSION = 'dnd-2024-manual-v1';
export const MAX_COMBATANTS = 200;

export const Kind = z.enum(['player', 'enemy', 'npc']);
export type Kind = z.infer<typeof Kind>;
export const EncounterStatus = z.enum(['draft', 'active', 'paused', 'completed']);
export type EncounterStatus = z.infer<typeof EncounterStatus>;
export const TurnPolicy = z.enum(['default', 'include', 'exclude']);
export type TurnPolicy = z.infer<typeof TurnPolicy>;

// ---------- templates ----------
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const CombatantFields = z.object({
  kind: Kind,
  name: z.string().trim().min(1).max(200),
  maxHp: int(1, 1_000_000),
  startingHp: int(0, 1_000_000).nullable().default(null), // null => use maxHp
  startingTempHp: int(0, 1_000_000).default(0),
  armorClass: int(0, 1000),
  initiativeModifier: int(-1000, 1000),
  speedFt: int(0, 1_000_000),
  className: z.string().max(200).nullable().default(null),
  level: int(1, 20).nullable().default(null),
  passivePerception: int(0, 1000).nullable().default(null),
  notes: z.string().max(20_000).default(''),
});
export type CombatantFields = z.infer<typeof CombatantFields>;

export const TemplateInput = CombatantFields.extend({
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
}).refine((t) => t.startingHp === null || t.startingHp <= t.maxHp, {
  path: ['startingHp'],
  message: 'Starting HP cannot exceed max HP',
});
export type TemplateInput = z.infer<typeof TemplateInput>;

export type Template = TemplateInput & {
  id: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

// ---------- encounter snapshot (server -> client) ----------
export type InitiativeMode = 'total' | 'roll';

export type CombatantDto = {
  id: string;
  templateId: string | null;
  kind: Kind;
  name: string;
  maxHp: number;
  currentHp: number;
  tempHp: number;
  startingHp: number;
  startingTempHp: number;
  armorClass: number;
  initiativeModifier: number;
  speedFt: number;
  className: string | null;
  level: number | null;
  passivePerception: number | null;
  notes: string;
  initiativeTotal: number | null; // the value that applies from the NEXT round while combat runs
  initiativeRoll: number | null;
  initiativeMode: InitiativeMode;
  tieRank: number;
  turnPolicy: TurnPolicy;
  exhaustionLevel: number; // 0-6
  removedAt: number | null; // tombstone
  eligible: boolean; // server-computed: would be scheduled in a new round right now
};

export type ConditionDto = {
  id: string;
  targetCombatantId: string;
  conditionKey: ConditionKey;
  sourceCombatantId: string | null;
  sourceLabel: string;
  notes: string;
  effectId: string | null; // internal duration or legacy concentration link; UI edits the condition directly
};

export const ConcentrationSchema = z.strictObject({
  id: z.uuid(), combatantId: z.uuid(), name: z.string().trim().min(1).max(200),
  startedAt: int(0, Number.MAX_SAFE_INTEGER),
  startBoundary: z.strictObject({ version: int(1, Number.MAX_SAFE_INTEGER), round: int(0, 1_000_000), activeCombatantId: z.uuid().nullable() }),
  linkedEffects: z.array(z.strictObject({ id: z.uuid(), name: z.string().trim().min(1).max(200) })).min(1).max(200),
  checks: z.array(z.strictObject({ id: z.uuid(), damage: int(1, 1_000_000), dc: int(10, 30), createdVersion: int(1, Number.MAX_SAFE_INTEGER) })),
});
export type ConcentrationDto = z.infer<typeof ConcentrationSchema>;
export const ConcentrationsSchema = z.array(ConcentrationSchema).max(MAX_COMBATANTS);

// Durations use explicit boundaries, independently of the creature that created an effect.
export const BoundaryKind = z.enum(['TURN_END', 'ROUND_END', 'ROUND_START', 'TURN_START', 'ENCOUNTER_END']);
export type BoundaryKind = z.infer<typeof BoundaryKind>;
export const SaveAbility = z.enum(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']);
export const EffectDuration = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('next-turn'), anchorCombatantId: z.uuid(), phase: z.enum(['start', 'end']) }),
  z.strictObject({ kind: z.literal('rounds'), count: int(1, 1000), anchorCombatantId: z.uuid().nullable(), phase: z.enum(['start', 'end']) }),
  z.strictObject({ kind: z.literal('concentration'), concentrationId: z.uuid() }),
  z.strictObject({ kind: z.literal('save-ends'), phase: z.enum(['start', 'end']), ability: SaveAbility, dc: int(1, 1000).nullable() }),
  z.strictObject({ kind: z.literal('encounter-end') }),
]);
export type EffectDuration = z.infer<typeof EffectDuration>;
export const EffectInput = z.strictObject({
  name: z.string().trim().min(1).max(200), sourceCombatantId: z.uuid().nullable(),
  targetCombatantIds: z.array(z.uuid()).min(1).max(MAX_COMBATANTS), duration: EffectDuration,
});
export type EffectInput = z.infer<typeof EffectInput>;
export const EffectSchema = EffectInput.extend({
  id: z.uuid(), createdVersion: int(1, Number.MAX_SAFE_INTEGER), createdBoundaryId: int(0, Number.MAX_SAFE_INTEGER),
  armedBoundaryId: int(0, Number.MAX_SAFE_INTEGER).nullable(), expiresRound: int(1, 1_001_000).nullable(),
});
export type EffectDto = z.infer<typeof EffectSchema>;
export const ReminderTrigger = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('turn'), anchorCombatantId: z.uuid(), phase: z.enum(['start', 'end']) }),
  z.strictObject({ kind: z.literal('round'), phase: z.enum(['start', 'end']) }),
]);
export type ReminderTrigger = z.infer<typeof ReminderTrigger>;
export const ReminderKind = z.enum(['saving-throw', 'damage', 'feature', 'note']);
export const ReminderInput = z.strictObject({
  name: z.string().trim().min(1).max(200), notes: z.string().max(2000), kind: ReminderKind,
  trigger: ReminderTrigger, repeat: z.boolean(), effectId: z.uuid().nullable(),
});
export type ReminderInput = z.infer<typeof ReminderInput>;
export const ReminderSchema = ReminderInput.extend({
  id: z.uuid(), createdVersion: int(1, Number.MAX_SAFE_INTEGER), createdBoundaryId: int(0, Number.MAX_SAFE_INTEGER), enabled: z.boolean(),
});
export type ReminderDto = z.infer<typeof ReminderSchema>;
export const OccurrenceSchema = z.strictObject({
  id: z.uuid(), reminderId: z.uuid().nullable(), effectId: z.uuid().nullable(), targetCombatantId: z.uuid().nullable(),
  name: z.string().min(1).max(200), notes: z.string().max(2400), kind: ReminderKind,
  boundaryId: int(1, Number.MAX_SAFE_INTEGER), triggerKind: BoundaryKind,
  round: int(0, 1_000_000), status: z.enum(['pending', 'acknowledged', 'resolved']),
  outcome: z.enum(['done', 'success', 'failure', 'effect-ended', 'disabled']).nullable(),
});
export type ReminderOccurrence = z.infer<typeof OccurrenceSchema>;
export const TimingSchema = z.strictObject({
  boundaryId: int(0, Number.MAX_SAFE_INTEGER), lastRoundEnd: int(0, 1_000_000),
  effects: z.array(EffectSchema).max(500), reminders: z.array(ReminderSchema).max(500), occurrences: z.array(OccurrenceSchema),
});
export type TimingDto = z.infer<typeof TimingSchema>;

export type ScheduleDto = {
  pendingIds: string[]; // remaining turns this round, in order (does not include activeId)
  actedIds: string[];
  // frozen initiative used for this round's order; compare with CombatantDto.initiativeTotal to show "effective next round"
  orderKeys: Record<string, { initiative: number; tieRank: number }>;
};

export type EncounterSnapshot = {
  id: string;
  name: string;
  notes: string;
  status: EncounterStatus;
  round: number; // 0 while draft
  activeCombatantId: string | null;
  schedule: ScheduleDto;
  canPreviousTurn: boolean; // a Next Turn checkpoint exists and is still valid
  skipZeroHpEnemies: boolean;
  version: number;
  rulesVersion: string;
  combatants: CombatantDto[]; // includes removed (removedAt != null); sorted by current-round display order
  conditions: ConditionDto[];
  concentrations: ConcentrationDto[];
  timing: TimingDto;
  nextTurnConsequences: string[];
  startedAt: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type EncounterSummary = {
  id: string;
  name: string;
  status: EncounterStatus;
  round: number;
  combatantCount: number;
  archivedAt: number | null;
  updatedAt: number;
};

// ---------- commands (client -> server) ----------
const id = z.string().uuid();
const initiativeInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('total'), total: int(-10_000, 10_000) }),
  z.object({ mode: z.literal('roll'), roll: int(1, 20) }), // server computes total = roll + initiativeModifier
]);
export type InitiativeInput = z.infer<typeof initiativeInput>;

export const InitiativeEntry = z.intersection(z.object({ combatantId: id }), initiativeInput);
export type InitiativeEntry = z.infer<typeof InitiativeEntry>;

export const AddEntry = z
  .object({
    templateId: id.optional(),
    adhoc: CombatantFields.optional(),
    name: z.string().trim().min(1).max(200).optional(), // instance name; defaults to the template/ad hoc name
    quantity: int(1, MAX_COMBATANTS).default(1), // quantity > 1 => names "<Name> 1", "<Name> 2", ...
    initiative: initiativeInput.optional(), // required by the server when joining a running encounter
  })
  .refine((e) => !!e.templateId !== !!e.adhoc, { message: 'Provide exactly one of templateId or adhoc' });
export type AddEntry = z.infer<typeof AddEntry>;

// Everything not handled by a dedicated command (no HP / initiative / scheduling here).
export const EditableCombatantPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    armorClass: int(0, 1000),
    speedFt: int(0, 1_000_000),
    initiativeModifier: int(-1000, 1000),
    passivePerception: int(0, 1000).nullable(),
    className: z.string().max(200).nullable(),
    level: int(1, 20).nullable(),
    notes: z.string().max(20_000),
  })
  .partial()
  .strict();
export type EditableCombatantPatch = z.infer<typeof EditableCombatantPatch>;

const JoinPolicy = z.enum(['next-round', 'current-round']);
export type JoinPolicy = z.infer<typeof JoinPolicy>;

export const EncounterCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('UPDATE_METADATA'), name: z.string().trim().min(1).max(200).optional(), notes: z.string().max(20_000).optional(), skipZeroHpEnemies: z.boolean().optional() }),
  z.object({ type: z.literal('ADD_COMBATANTS'), entries: z.array(AddEntry).min(1), joinPolicy: JoinPolicy.default('next-round') }),
  z.object({ type: z.literal('UPDATE_COMBATANT'), combatantId: id, patch: EditableCombatantPatch }),
  z.object({ type: z.literal('REMOVE_COMBATANT'), combatantId: id, concentrationPolicy: z.enum(['keep', 'end']).optional() }),
  z.object({ type: z.literal('REINSTATE_COMBATANT'), combatantId: id, joinPolicy: JoinPolicy.default('next-round') }),
  z.object({ type: z.literal('SET_TURN_POLICY'), combatantId: id, policy: TurnPolicy }),
  z.object({ type: z.literal('SET_INITIATIVE'), entries: z.array(InitiativeEntry).min(1) }), // shared initiative = several entries with the same total
  z.object({ type: z.literal('SET_TIE_ORDER'), combatantIds: z.array(id).min(2) }), // must be exactly one equal-total tie group
  z.object({ type: z.literal('APPLY_DAMAGE'), combatantId: id, amount: int(0, 1_000_000) }),
  z.object({ type: z.literal('APPLY_HEALING'), combatantId: id, amount: int(0, 1_000_000) }),
  z.object({ type: z.literal('SET_HP'), combatantId: id, value: int(0, 1_000_000) }), // 0..maxHp else INVALID_STATE/VALIDATION
  z.object({ type: z.literal('SET_MAX_HP'), combatantId: id, value: int(1, 1_000_000) }), // clamps current/starting HP down if needed
  z.object({ type: z.literal('GRANT_TEMP_HP'), combatantId: id, amount: int(0, 1_000_000), choice: z.enum(['keep', 'replace']) }),
  z.object({ type: z.literal('SET_TEMP_HP'), combatantId: id, value: int(0, 1_000_000) }),
  z.object({ type: z.literal('ADD_CONDITION'), combatantId: id, conditionKey: ConditionKey, sourceCombatantId: id.optional(), sourceLabel: z.string().max(200).default(''), notes: z.string().max(2000).default(''), effectId: id.optional(), duration: EffectDuration.optional() }),
  z.object({ type: z.literal('UPDATE_CONDITION'), applicationId: id, sourceCombatantId: id.nullable(), sourceLabel: z.string().max(200), notes: z.string().max(2000), duration: EffectDuration }),
  z.object({ type: z.literal('START_CONCENTRATION'), combatantId: id, name: z.string().trim().min(1).max(200), replace: z.boolean().optional() }),
  z.object({ type: z.literal('END_CONCENTRATION'), concentrationId: id, reason: z.enum(['manual', 'death']).optional() }),
  z.object({ type: z.literal('ADD_CONCENTRATION_EFFECT'), concentrationId: id, name: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal('RESOLVE_CONCENTRATION_CHECK'), concentrationId: id, checkId: id, outcome: z.enum(['success', 'failure']) }),
  z.object({ type: z.literal('CREATE_EFFECT'), effect: EffectInput }),
  z.object({ type: z.literal('UPDATE_EFFECT'), effectId: id, effect: EffectInput }),
  z.object({ type: z.literal('END_EFFECT'), effectId: id }),
  z.object({ type: z.literal('CREATE_REMINDER'), reminder: ReminderInput }),
  z.object({ type: z.literal('DISABLE_REMINDER'), reminderId: id }),
  z.object({ type: z.literal('ACKNOWLEDGE_REMINDER'), occurrenceId: id }),
  z.object({ type: z.literal('RESOLVE_REMINDER'), occurrenceId: id, outcome: z.enum(['done', 'success', 'failure']) }),
  z.object({ type: z.literal('REMOVE_CONDITION'), applicationId: id }),
  z.object({ type: z.literal('REMOVE_ALL_CONDITION_SOURCES'), combatantId: id, conditionKey: ConditionKey }),
  z.object({ type: z.literal('SET_EXHAUSTION'), combatantId: id, level: int(0, 6) }),
  z.object({ type: z.literal('START_COMBAT') }),
  z.object({ type: z.literal('NEXT_TURN') }),
  z.object({ type: z.literal('PREVIOUS_TURN') }),
  z.object({ type: z.literal('PAUSE_COMBAT') }),
  z.object({ type: z.literal('RESUME_COMBAT') }),
  z.object({ type: z.literal('COMPLETE_COMBAT') }),
  z.object({ type: z.literal('ARCHIVE_ENCOUNTER') }),
  z.object({ type: z.literal('UNARCHIVE_ENCOUNTER') }),
]);
export type EncounterCommand = z.infer<typeof EncounterCommand>;

export const CommandEnvelope = z.object({ expectedVersion: int(1, Number.MAX_SAFE_INTEGER), command: EncounterCommand });
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

export type CommandResponse = { snapshot: EncounterSnapshot; affectedIds: string[] };

export const DuplicateOptions = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  hpSource: z.enum(['starting', 'current']).default('starting'),
  copyConditions: z.boolean().default(false),
});
export type DuplicateOptions = z.infer<typeof DuplicateOptions>;

// ---------- settings / data ----------
export type BackupInfo = { id: string; createdAt: number; reason: 'manual' | 'auto' | 'pre-restore' | 'pre-migration'; sizeBytes: number };
export type Settings = {
  appVersion: string;
  rulesVersion: string;
  schemaVersion: number;
  dataDir: string;
  backupDir: string;
  latestBackup: BackupInfo | null;
};
export type RestorePreview = {
  formatVersion: number;
  exportedAt: number;
  counts: { templates: number; encounters: number; combatants: number; conditions: number };
};
// ExportFile is a JSON object: { formatVersion: 1, appVersion, exportedAt, tables: { templates: [...], encounters: [...], combatants: [...], conditions: [...] } }
// with rows as stored (server-defined, validated server-side). Treated as opaque by the web client.
export type ExportFile = Record<string, unknown>;

export type ApiError = {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]>; currentVersion?: number };
};
