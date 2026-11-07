// JSON export / restore (PRD 11.3). Rows are exported exactly as stored; restore validates them strictly,
// then replaces everything in ONE transaction (any failure rolls back and leaves the live data untouched).
import { z } from 'zod';
import { CheckpointSchema, ScheduleSchema } from '../domain/encounter';
import { AppError } from '../domain/errors';
import { concentrationDc, isIncapacitated } from '../domain/concentration';
import { CombatantFields, ConditionKey, ConcentrationsSchema, EncounterStatus, RestorePreview, TurnPolicy, TimingSchema, type ConcentrationDto, type TimingDto } from '../shared/contract';
import { emptyTiming } from '../domain/timing';
import { combatants, conditions, encounters, templates } from './schema';
import type { Db } from './repo';

export const FORMAT_VERSION = 1;

const I = (lo: number, hi: number) => z.number().int().min(lo).max(hi);
const Id = z.uuid();
const Ts = I(0, Number.MAX_SAFE_INTEGER);
const jsonOk = (schema: z.ZodType) => (text: string) => {
  try { return schema.safeParse(JSON.parse(text)).success; } catch { return false; }
};
const hpWithinMax = (c: { currentHp?: number; startingHp: number | null; maxHp: number }) =>
  (c.currentHp ?? 0) <= c.maxHp && (c.startingHp ?? 0) <= c.maxHp;

const TemplateRow = CombatantFields.extend({
  id: Id,
  tagsJson: z.string().refine(jsonOk(z.array(z.string().min(1).max(50)).max(50)), 'Must be a JSON array of tags'),
  archivedAt: Ts.nullable(), createdAt: Ts, updatedAt: Ts,
}).strict().refine(hpWithinMax, 'HP values cannot exceed max HP');

const EncounterRow = z.strictObject({
  id: Id, name: z.string().min(1).max(200), notes: z.string().max(20_000), status: EncounterStatus, round: I(0, 1_000_000),
  activeCombatantId: Id.nullable(),
  scheduleJson: z.string().refine(jsonOk(ScheduleSchema), 'Invalid schedule'),
  concentrationsJson: z.string().refine(jsonOk(ConcentrationsSchema), 'Invalid concentrations').default('[]'),
  timingJson: z.string().refine(jsonOk(TimingSchema), 'Invalid effects and reminders').default(JSON.stringify(emptyTiming())),
  lastTurnCheckpointJson: z.string().refine(jsonOk(CheckpointSchema), 'Invalid checkpoint').nullable(),
  rulesVersion: z.string().min(1).max(100), skipZeroHpEnemies: z.boolean(), version: I(1, Number.MAX_SAFE_INTEGER),
  startedAt: Ts.nullable(), completedAt: Ts.nullable(), archivedAt: Ts.nullable(), createdAt: Ts, updatedAt: Ts,
});

const CombatantRow = CombatantFields.extend({
  id: Id, encounterId: Id, templateId: Id.nullable(),
  currentHp: I(0, 1_000_000), tempHp: I(0, 1_000_000), startingHp: I(0, 1_000_000),
  initiativeTotal: I(-10_000, 10_000).nullable(), initiativeRoll: I(1, 20).nullable(), initiativeMode: z.enum(['total', 'roll']),
  tieRank: I(0, 1_000_000), turnPolicy: TurnPolicy, exhaustionLevel: I(0, 6), removedAt: Ts.nullable(),
}).strict().refine(hpWithinMax, 'HP values cannot exceed max HP');

const ConditionRow = z.strictObject({
  id: Id, encounterId: Id, targetCombatantId: Id, conditionKey: ConditionKey, sourceCombatantId: Id.nullable(),
  sourceLabel: z.string().max(200), notes: z.string().max(2000),
  effectId: Id.nullable().default(null),
});

const ExportFile = z.strictObject({
  formatVersion: z.literal(FORMAT_VERSION), appVersion: z.string(), exportedAt: Ts,
  tables: z.strictObject({ templates: z.array(TemplateRow), encounters: z.array(EncounterRow), combatants: z.array(CombatantRow), conditions: z.array(ConditionRow) }),
});
type Tables = z.infer<typeof ExportFile>['tables'];
type StoredEncounter = Tables['encounters'][number];
type EffectLink = { id: string; combatantId: string | null; targets: string[] | null };
type IsMember = (id: string | null) => boolean;
const unique = (ids: string[]) => new Set(ids).size === ids.length;


export function exportData(db: Db, appVersion: string) {
  return db.transaction((tx) => ({
    formatVersion: FORMAT_VERSION, appVersion, exportedAt: Date.now(),
    tables: {
      templates: tx.select().from(templates).all(),
      encounters: tx.select().from(encounters).all(),
      combatants: tx.select().from(combatants).all(),
      conditions: tx.select().from(conditions).all(),
    },
  }));
}

/** Validates an export file (shape, bounds, relationships). Throws a 422 AppError describing the first problems. */
export function validateExport(body: unknown): z.infer<typeof ExportFile> {
  const version = (body as { formatVersion?: unknown } | null)?.formatVersion;
  if (typeof body !== 'object' || body === null || version !== FORMAT_VERSION) {
    throw new AppError('VALIDATION', `Unsupported or missing formatVersion (this app reads version ${FORMAT_VERSION})`);
  }
  const parsed = ExportFile.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION', `Invalid backup file at ${issue.path.join('.') || 'root'}: ${issue.message}`);
  }
  const file = parsed.data;
  const problem = relationshipProblem(file.tables);
  if (problem) throw new AppError('VALIDATION', `Invalid backup file: ${problem}`);
  return file;
}

function relationshipProblem(t: Tables): string | null {
  if (
    ![t.templates, t.encounters, t.combatants, t.conditions].every((rows) =>
      unique(rows.map((reminder) => reminder.id)),
    )
  )
    return 'duplicate ids';
  const templateIds = new Set(t.templates.map((reminder) => reminder.id));
  const encounterIds = new Set(t.encounters.map((reminder) => reminder.id));
  const members = new Set(t.combatants.map((c) => `${c.encounterId}/${c.id}`));
  if (t.encounters.filter((encounter) => encounter.status === 'active').length > 1)
    return 'more than one active encounter';
  if (t.encounters.some((encounter) => encounter.status === 'active' && encounter.archivedAt !== null))
    return 'an archived encounter is active';
  if (
    t.encounters.some(
      (encounter) => encounter.activeCombatantId !== null && !members.has(`${encounter.id}/${encounter.activeCombatantId}`),
    )
  )
    return 'active combatant is not in its encounter';
  if (
    t.combatants.some(
      (c) =>
        !encounterIds.has(c.encounterId) ||
        (c.templateId !== null && !templateIds.has(c.templateId)),
    )
  )
    return 'combatant references a missing encounter or template';
  const bad = t.conditions.some(
    (k) =>
      !members.has(`${k.encounterId}/${k.targetCombatantId}`) ||
      (k.sourceCombatantId !== null && !members.has(`${k.encounterId}/${k.sourceCombatantId}`)),
  );
  if (bad) return 'condition references a combatant outside its encounter';
  for (const encounter of t.encounters) {
    const problem = encounterRelationshipProblem(encounter, t.conditions, members);
    if (problem) return problem;
  }
  return null;
}

// Keep this order stable: restore reports the first invalid relationship.
function encounterRelationshipProblem(
  encounter: StoredEncounter,
  allConditions: Tables['conditions'],
  members: Set<string>,
): string | null {
  const concentrations = ConcentrationsSchema.parse(JSON.parse(encounter.concentrationsJson));
  const timing = TimingSchema.parse(JSON.parse(encounter.timingJson));
  const effects: EffectLink[] = [
    ...concentrations.flatMap((c) =>
      c.linkedEffects.map((effect) => ({
        id: effect.id,
        combatantId: c.combatantId,
        targets: null,
      })),
    ),
    ...timing.effects.map((effect) => ({
      id: effect.id,
      combatantId: effect.sourceCombatantId,
      targets: effect.targetCombatantIds,
    })),
  ];
  const conditions = allConditions.filter((condition) => condition.encounterId === encounter.id);
  const member: IsMember = (id) => id === null || members.has(`${encounter.id}/${id}`);
  const concentrationProblem = concentrationRelationshipProblem(encounter, concentrations, conditions, effects, member);
  if (concentrationProblem) return concentrationProblem;
  if (
    timing.lastRoundEnd > encounter.round ||
    !unique([...effects.map((effect) => effect.id), ...timing.reminders.map((reminder) => reminder.id)]) ||
    !unique(timing.occurrences.map((occurrence) => occurrence.id))
  )
    return 'invalid or duplicate timing records';
  return (
    effectRelationshipProblem(encounter, concentrations, timing, member) ||
    reminderRelationshipProblem(encounter, timing, member) ||
    occurrenceRelationshipProblem(timing, member)
  );
}

function concentrationRelationshipProblem(
  encounter: StoredEncounter,
  concentrations: ConcentrationDto[],
  conditions: Tables['conditions'],
  effects: EffectLink[],
  member: IsMember,
): string | null {
  const checks = concentrations.flatMap((c) => c.checks);
  if (
    !unique(concentrations.map((c) => c.id)) ||
    !unique(concentrations.map((c) => c.combatantId)) ||
    !unique(effects.map((effect) => effect.id)) ||
    !unique(checks.map((c) => c.id))
  )
    return 'duplicate concentration, caster, effect, or check ids';
  if (concentrations.some((c) => !member(c.combatantId)))
    return 'concentration caster is outside its encounter';
  if (concentrations.some((c) => isIncapacitated(conditions, c.combatantId)))
    return 'an Incapacitated combatant is concentrating';
  if (
    concentrations.some(
      (c) =>
        c.startBoundary.version > encounter.version ||
        c.checks.some(
          (k) =>
            k.createdVersion < c.startBoundary.version ||
            k.createdVersion > encounter.version ||
            k.dc !== concentrationDc(k.damage),
        ),
    )
  )
    return 'invalid concentration boundary or check DC';
  if (
    concentrations.some(
      (c) =>
        c.startBoundary.activeCombatantId !== null && !member(c.startBoundary.activeCombatantId),
    )
  )
    return 'concentration start boundary references a combatant outside its encounter';
  if (
    conditions.some(
      (k) =>
        k.effectId !== null &&
        !effects.some(
          (effect) =>
            effect.id === k.effectId &&
            effect.combatantId === k.sourceCombatantId &&
            (effect.targets === null || effect.targets.includes(k.targetCombatantId)),
        ),
    )
  )
    return 'condition references a missing or mismatched effect';
  return null;
}

function effectRelationshipProblem(
  encounter: StoredEncounter,
  concentrations: ConcentrationDto[],
  timing: TimingDto,
  member: IsMember,
): string | null {
  for (const effect of timing.effects) {
    if (
      !member(effect.sourceCombatantId) ||
      effect.targetCombatantIds.some((id) => !member(id)) ||
      !unique(effect.targetCombatantIds)
    )
      return 'effect source or targets are invalid';
    if (
      effect.createdVersion > encounter.version ||
      effect.createdBoundaryId > timing.boundaryId ||
      (effect.armedBoundaryId !== null &&
        (effect.armedBoundaryId <= effect.createdBoundaryId || effect.armedBoundaryId > timing.boundaryId))
    )
      return 'effect boundary is invalid';
    const d = effect.duration;
    if ((d.kind === 'rounds') !== (effect.expiresRound !== null))
      return 'effect expiry round is invalid';
    if ((d.kind === 'next-turn' || d.kind === 'rounds') && !member(d.anchorCombatantId))
      return 'effect anchor is outside its encounter';
    if (
      d.kind === 'concentration' &&
      !concentrations.some((c) => c.id === d.concentrationId && c.combatantId === effect.sourceCombatantId)
    )
      return 'effect concentration link is invalid';
  }
  return null;
}

function reminderRelationshipProblem(
  encounter: StoredEncounter,
  timing: TimingDto,
  member: IsMember,
): string | null {
  for (const reminder of timing.reminders) {
    if (
      reminder.createdVersion > encounter.version ||
      reminder.createdBoundaryId > timing.boundaryId ||
      (reminder.trigger.kind === 'turn' && !member(reminder.trigger.anchorCombatantId))
    )
      return 'reminder boundary or anchor is invalid';
    if (reminder.enabled && reminder.effectId !== null && !timing.effects.some((effect) => effect.id === reminder.effectId))
      return 'reminder effect is missing';
  }
  return null;
}

function occurrenceRelationshipProblem(timing: TimingDto, member: IsMember): string | null {
  if (
    !unique(
      timing.occurrences.map(
        (occurrence) => `${occurrence.reminderId ?? occurrence.effectId}/${occurrence.boundaryId}/${occurrence.triggerKind}`,
      ),
    )
  )
    return 'duplicate reminder occurrence';
  for (const occurrence of timing.occurrences) {
    if (
      (!occurrence.reminderId && !occurrence.effectId) ||
      occurrence.boundaryId > timing.boundaryId ||
      !member(occurrence.targetCombatantId) ||
      (occurrence.status === 'resolved') !== (occurrence.outcome !== null)
    )
      return 'invalid reminder occurrence';
    const reminder = timing.reminders.find((reminder) => reminder.id === occurrence.reminderId);
    if (occurrence.reminderId !== null && !reminder) return 'reminder occurrence definition is missing';
    if (
      reminder &&
      (occurrence.effectId !== reminder.effectId ||
        occurrence.kind !== reminder.kind ||
        occurrence.boundaryId <= reminder.createdBoundaryId ||
        occurrence.triggerKind !==
          (reminder.trigger.kind === 'turn'
            ? reminder.trigger.phase === 'start'
              ? 'TURN_START'
              : 'TURN_END'
            : reminder.trigger.phase === 'start'
              ? 'ROUND_START'
              : 'ROUND_END') ||
        occurrence.targetCombatantId !== (reminder.trigger.kind === 'turn' ? reminder.trigger.anchorCombatantId : null))
    )
      return 'reminder occurrence does not match its definition';
    if (
      occurrence.reminderId === null &&
      occurrence.status !== 'resolved' &&
      !timing.effects.some((effect) => effect.id === occurrence.effectId)
    )
      return 'pending save references an ended effect';
    if (
      occurrence.reminderId === null &&
      (occurrence.kind !== 'saving-throw' || occurrence.targetCombatantId === null || occurrence.outcome === 'done')
    )
      return 'save-ends occurrence is invalid';
    if (occurrence.reminderId === null && occurrence.status !== 'resolved') {
      const effect = timing.effects.find((effect) => effect.id === occurrence.effectId);
      if (
        !effect ||
        effect.duration.kind !== 'save-ends' ||
        !effect.targetCombatantIds.includes(occurrence.targetCombatantId!) ||
        occurrence.boundaryId <= effect.createdBoundaryId ||
        occurrence.triggerKind !== (effect.duration.phase === 'start' ? 'TURN_START' : 'TURN_END')
      )
        return 'pending save-ends occurrence does not match its effect';
    }
  }
  return null;
}

export function previewOf(file: z.infer<typeof ExportFile>): RestorePreview {
  const n = (rows: unknown[]) => rows.length;
  const t = file.tables;
  return {
    formatVersion: file.formatVersion, exportedAt: file.exportedAt,
    counts: { templates: n(t.templates), encounters: n(t.encounters), combatants: n(t.combatants), conditions: n(t.conditions) },
  };
}

/** Replace all data with the (already validated) file. One transaction: rollback on any failure. */
export function replaceAll(db: Db, file: z.infer<typeof ExportFile>) {
  const { tables } = file;
  const chunks = <T>(rows: T[], size = 50) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
  db.transaction((tx) => {
    tx.delete(conditions).run();
    tx.delete(combatants).run();
    tx.delete(encounters).run();
    tx.delete(templates).run();
    for (const rows of chunks(tables.templates)) tx.insert(templates).values(rows).run();
    for (const rows of chunks(tables.encounters)) tx.insert(encounters).values(rows).run();
    for (const rows of chunks(tables.combatants)) tx.insert(combatants).values(rows).run();
    for (const rows of chunks(tables.conditions)) tx.insert(conditions).values(rows).run();
  }, { behavior: 'immediate' });
}
