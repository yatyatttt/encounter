// Drizzle schema (PRD 8.2, trimmed to what the app uses). Bounds are enforced in SQL as well as in Zod.
import { sql, type SQL } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const KINDS = ['player', 'enemy', 'npc'] as const;
const CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
] as const;
const STATUSES = ['draft', 'active', 'paused', 'completed'] as const;
const inList = (col: unknown, values: readonly string[]): SQL =>
  sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
const range = (col: unknown, lo: number, hi: number | SQL): SQL =>
  sql`${col} between ${sql.raw(String(lo))} and ${typeof hi === 'number' ? sql.raw(String(hi)) : hi}`;
const optRange = (col: unknown, lo: number, hi: number): SQL => sql`(${col} is null or ${range(col, lo, hi)})`;

export const templates = sqliteTable(
  'combatant_templates',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: KINDS }).notNull(),
    name: text('name').notNull(),
    className: text('class_name'),
    level: integer('level'),
    maxHp: integer('max_hp').notNull(),
    startingHp: integer('starting_hp'),
    startingTempHp: integer('starting_temp_hp').notNull().default(0),
    armorClass: integer('armor_class').notNull(),
    initiativeModifier: integer('initiative_modifier').notNull(),
    speedFt: integer('speed_ft').notNull(),
    passivePerception: integer('passive_perception'),
    notes: text('notes').notNull().default(''),
    tagsJson: text('tags_json').notNull().default('[]'),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('templates_kind', inList(t.kind, KINDS)),
    check('templates_name', sql`length(${t.name}) > 0`),
    check('templates_level', optRange(t.level, 1, 20)),
    check('templates_max_hp', range(t.maxHp, 1, 1_000_000)),
    check('templates_starting_hp', sql`(${t.startingHp} is null or ${range(t.startingHp, 0, sql`${t.maxHp}`)})`),
    check('templates_starting_temp_hp', range(t.startingTempHp, 0, 1_000_000)),
    check('templates_ac', range(t.armorClass, 0, 1000)),
    check('templates_init_mod', range(t.initiativeModifier, -1000, 1000)),
    check('templates_speed', range(t.speedFt, 0, 1_000_000)),
    check('templates_pp', optRange(t.passivePerception, 0, 1000)),
    index('templates_kind_archived').on(t.kind, t.archivedAt),
    index('templates_name').on(t.name),
  ],
);

export const encounters = sqliteTable(
  'encounters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: STATUSES }).notNull(),
    round: integer('round').notNull(),
    activeCombatantId: text('active_combatant_id'),
    scheduleJson: text('schedule_json').notNull(), // { pendingIds, actedIds, orderKeys }; round/activeId are the scalar columns
    lastTurnCheckpointJson: text('last_turn_checkpoint_json'),
    rulesVersion: text('rules_version').notNull(),
    skipZeroHpEnemies: integer('skip_zero_hp_enemies', { mode: 'boolean' }).notNull().default(true),
    version: integer('version').notNull(),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('encounters_name', sql`length(${t.name}) > 0`),
    check('encounters_status', inList(t.status, STATUSES)),
    check('encounters_round', sql`${t.round} >= 0`),
    check('encounters_version', sql`${t.version} >= 1`),
    check('encounters_active_not_archived', sql`not (${t.status} = 'active' and ${t.archivedAt} is not null)`),
    uniqueIndex('encounters_one_active').on(sql`(1)`).where(sql`${t.status} = 'active'`),
    index('encounters_status_archived_updated').on(t.status, t.archivedAt, t.updatedAt),
  ],
);

export const combatants = sqliteTable(
  'encounter_combatants',
  {
    id: text('id').primaryKey(),
    encounterId: text('encounter_id').notNull().references(() => encounters.id),
    templateId: text('template_id').references(() => templates.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: KINDS }).notNull(),
    name: text('name').notNull(),
    maxHp: integer('max_hp').notNull(),
    currentHp: integer('current_hp').notNull(),
    tempHp: integer('temp_hp').notNull(),
    startingHp: integer('starting_hp').notNull(),
    startingTempHp: integer('starting_temp_hp').notNull(),
    armorClass: integer('armor_class').notNull(),
    initiativeModifier: integer('initiative_modifier').notNull(),
    speedFt: integer('speed_ft').notNull(),
    className: text('class_name'),
    level: integer('level'),
    passivePerception: integer('passive_perception'),
    initiativeTotal: integer('initiative_total'),
    initiativeRoll: integer('initiative_roll'),
    initiativeMode: text('initiative_mode', { enum: ['total', 'roll'] }).notNull(),
    tieRank: integer('tie_rank').notNull(),
    turnPolicy: text('turn_policy', { enum: ['default', 'include', 'exclude'] }).notNull(),
    exhaustionLevel: integer('exhaustion_level').notNull(),
    notes: text('notes').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [
    check('combatants_kind', inList(t.kind, KINDS)),
    check('combatants_name', sql`length(${t.name}) > 0`),
    check('combatants_max_hp', range(t.maxHp, 1, 1_000_000)),
    check('combatants_current_hp', range(t.currentHp, 0, sql`${t.maxHp}`)),
    check('combatants_temp_hp', range(t.tempHp, 0, 1_000_000)),
    check('combatants_starting_hp', range(t.startingHp, 0, sql`${t.maxHp}`)),
    check('combatants_starting_temp_hp', range(t.startingTempHp, 0, 1_000_000)),
    check('combatants_ac', range(t.armorClass, 0, 1000)),
    check('combatants_init_mod', range(t.initiativeModifier, -1000, 1000)),
    check('combatants_speed', range(t.speedFt, 0, 1_000_000)),
    check('combatants_level', optRange(t.level, 1, 20)),
    check('combatants_pp', optRange(t.passivePerception, 0, 1000)),
    check('combatants_init_total', optRange(t.initiativeTotal, -10_000, 10_000)),
    check('combatants_init_roll', optRange(t.initiativeRoll, 1, 20)),
    check('combatants_init_mode', inList(t.initiativeMode, ['total', 'roll'])),
    check('combatants_tie_rank', sql`${t.tieRank} >= 0`),
    check('combatants_turn_policy', inList(t.turnPolicy, ['default', 'include', 'exclude'])),
    check('combatants_exhaustion', range(t.exhaustionLevel, 0, 6)),
    uniqueIndex('combatants_encounter_id').on(t.encounterId, t.id), // target of the composite FKs below
    index('combatants_encounter_initiative').on(t.encounterId, t.initiativeTotal, t.tieRank),
  ],
);

export const conditions = sqliteTable(
  'condition_applications',
  {
    id: text('id').primaryKey(),
    encounterId: text('encounter_id').notNull().references(() => encounters.id),
    targetCombatantId: text('target_combatant_id').notNull(),
    conditionKey: text('condition_key', { enum: CONDITIONS }).notNull(),
    sourceCombatantId: text('source_combatant_id'),
    sourceLabel: text('source_label').notNull(),
    notes: text('notes').notNull(),
  },
  (t) => [
    check('conditions_key', inList(t.conditionKey, CONDITIONS)),
    foreignKey({ columns: [t.encounterId, t.targetCombatantId], foreignColumns: [combatants.encounterId, combatants.id] }),
    foreignKey({ columns: [t.encounterId, t.sourceCombatantId], foreignColumns: [combatants.encounterId, combatants.id] }),
    index('conditions_encounter_target').on(t.encounterId, t.targetCombatantId),
    index('conditions_encounter_source').on(t.encounterId, t.sourceCombatantId),
  ],
);

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
