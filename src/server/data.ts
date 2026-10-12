// JSON export / restore (PRD 11.3). Rows are exported exactly as stored; restore validates them strictly,
// then replaces everything in ONE transaction (any failure rolls back and leaves the live data untouched).
import { z } from 'zod';
import { CheckpointSchema, ScheduleSchema } from '../domain/encounter';
import { AppError } from '../domain/errors';
import { concentrationDc, isIncapacitated } from '../domain/concentration';
import { CombatantFields, ConditionKey, ConcentrationsSchema, EncounterStatus, RestorePreview, TurnPolicy, TimingSchema } from '../shared/contract';
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
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (![t.templates, t.encounters, t.combatants, t.conditions].every((rows) => unique(rows.map((r) => r.id)))) return 'duplicate ids';
  const templateIds = new Set(t.templates.map((r) => r.id));
  const encounterIds = new Set(t.encounters.map((r) => r.id));
  const members = new Set(t.combatants.map((c) => `${c.encounterId}/${c.id}`));
  if (t.encounters.filter((e) => e.status === 'active').length > 1) return 'more than one active encounter';
  if (t.encounters.some((e) => e.status === 'active' && e.archivedAt !== null)) return 'an archived encounter is active';
  if (t.encounters.some((e) => e.activeCombatantId !== null && !members.has(`${e.id}/${e.activeCombatantId}`))) return 'active combatant is not in its encounter';
  if (t.combatants.some((c) => !encounterIds.has(c.encounterId) || (c.templateId !== null && !templateIds.has(c.templateId)))) return 'combatant references a missing encounter or template';
  const bad = t.conditions.some((k) => !members.has(`${k.encounterId}/${k.targetCombatantId}`) || (k.sourceCombatantId !== null && !members.has(`${k.encounterId}/${k.sourceCombatantId}`)));
  if (bad) return 'condition references a combatant outside its encounter';
  for (const e of t.encounters) {
    const cs = ConcentrationsSchema.parse(JSON.parse(e.concentrationsJson));
    const timing = TimingSchema.parse(JSON.parse(e.timingJson));
    const effects = [...cs.flatMap((c) => c.linkedEffects.map((effect) => ({ ...effect, combatantId: c.combatantId, targets: null as string[] | null }))), ...timing.effects.map((f) => ({ ...f, combatantId: f.sourceCombatantId, targets: f.targetCombatantIds }))];
    const checks = cs.flatMap((c) => c.checks);
    if (!unique(cs.map((c) => c.id)) || !unique(cs.map((c) => c.combatantId)) || !unique(effects.map((f) => f.id)) || !unique(checks.map((c) => c.id))) return 'duplicate concentration, caster, effect, or check ids';
    const conditions = t.conditions.filter((k) => k.encounterId === e.id);
    if (cs.some((c) => !members.has(`${e.id}/${c.combatantId}`))) return 'concentration caster is outside its encounter';
    if (cs.some((c) => isIncapacitated(conditions, c.combatantId))) return 'an Incapacitated combatant is concentrating';
    if (cs.some((c) => c.startBoundary.version > e.version || c.checks.some((k) => k.createdVersion < c.startBoundary.version || k.createdVersion > e.version || k.dc !== concentrationDc(k.damage)))) return 'invalid concentration boundary or check DC';
    if (cs.some((c) => c.startBoundary.activeCombatantId !== null && !members.has(`${e.id}/${c.startBoundary.activeCombatantId}`))) return 'concentration start boundary references a combatant outside its encounter';
    if (conditions.some((k) => k.effectId !== null && !effects.some((f) => f.id === k.effectId && f.combatantId === k.sourceCombatantId && (f.targets === null || f.targets.includes(k.targetCombatantId))))) return 'condition references a missing or mismatched effect';
    const member = (id: string | null) => id === null || members.has(`${e.id}/${id}`);
    if (timing.lastRoundEnd > e.round || !unique([...effects.map((f) => f.id), ...timing.reminders.map((r) => r.id)]) || !unique(timing.occurrences.map((o) => o.id))) return 'invalid or duplicate timing records';
    for (const f of timing.effects) {
      if (!member(f.sourceCombatantId) || f.targetCombatantIds.some((id) => !member(id)) || !unique(f.targetCombatantIds)) return 'effect source or targets are invalid';
      if (f.createdVersion > e.version || f.createdBoundaryId > timing.boundaryId || (f.armedBoundaryId !== null && (f.armedBoundaryId <= f.createdBoundaryId || f.armedBoundaryId > timing.boundaryId))) return 'effect boundary is invalid';
      const d = f.duration;
      if ((d.kind === 'rounds') !== (f.expiresRound !== null)) return 'effect expiry round is invalid';
      if ((d.kind === 'next-turn' || d.kind === 'rounds') && !member(d.anchorCombatantId)) return 'effect anchor is outside its encounter';
      if (d.kind === 'concentration' && !cs.some((c) => c.id === d.concentrationId && c.combatantId === f.sourceCombatantId)) return 'effect concentration link is invalid';
    }
    for (const r of timing.reminders) {
      if (r.createdVersion > e.version || r.createdBoundaryId > timing.boundaryId || (r.trigger.kind === 'turn' && !member(r.trigger.anchorCombatantId))) return 'reminder boundary or anchor is invalid';
      if (r.enabled && r.effectId !== null && !timing.effects.some((f) => f.id === r.effectId)) return 'reminder effect is missing';
    }
    if (!unique(timing.occurrences.map((o) => `${o.reminderId ?? o.effectId}/${o.boundaryId}/${o.triggerKind}`))) return 'duplicate reminder occurrence';
    for (const o of timing.occurrences) {
      if ((!o.reminderId && !o.effectId) || o.boundaryId > timing.boundaryId || !member(o.targetCombatantId) || (o.status === 'resolved') !== (o.outcome !== null)) return 'invalid reminder occurrence';
      const r = timing.reminders.find((r) => r.id === o.reminderId);
      if (o.reminderId !== null && !r) return 'reminder occurrence definition is missing';
      if (r && (o.effectId !== r.effectId || o.kind !== r.kind || o.boundaryId <= r.createdBoundaryId || o.triggerKind !== (r.trigger.kind === 'turn' ? (r.trigger.phase === 'start' ? 'TURN_START' : 'TURN_END') : (r.trigger.phase === 'start' ? 'ROUND_START' : 'ROUND_END')) || o.targetCombatantId !== (r.trigger.kind === 'turn' ? r.trigger.anchorCombatantId : null))) return 'reminder occurrence does not match its definition';
      if (o.reminderId === null && o.status !== 'resolved' && !timing.effects.some((f) => f.id === o.effectId)) return 'pending save references an ended effect';
      if (o.reminderId === null && (o.kind !== 'saving-throw' || o.targetCombatantId === null || o.outcome === 'done')) return 'save-ends occurrence is invalid';
      if (o.reminderId === null && o.status !== 'resolved') {
        const f = timing.effects.find((f) => f.id === o.effectId);
        if (!f || f.duration.kind !== 'save-ends' || !f.targetCombatantIds.includes(o.targetCombatantId!) || o.boundaryId <= f.createdBoundaryId || o.triggerKind !== (f.duration.phase === 'start' ? 'TURN_START' : 'TURN_END')) return 'pending save-ends occurrence does not match its effect';
      }
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
