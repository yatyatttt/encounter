// Persistence for encounters and templates. Encounter state is loaded whole and saved whole (always inside a transaction).
import type Database from 'better-sqlite3';
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CheckpointSchema, ScheduleSchema, type EncounterState } from '../domain/encounter';
import type { CombatantFields, EncounterStatus, EncounterSummary, Template } from '../shared/contract';
import { combatants, conditions, encounters, templates } from './schema';

export type Db = BetterSQLite3Database & { $client: Database.Database };
/** The query surface shared by Db and a transaction handle. */
export type Q = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

const rowid = sql`rowid`;

export function loadEncounter(q: Q, id: string): EncounterState | undefined {
  const row = q.select().from(encounters).where(eq(encounters.id, id)).get();
  if (!row) return undefined;
  const { scheduleJson, lastTurnCheckpointJson, activeCombatantId, ...rest } = row;
  return {
    ...rest,
    activeId: activeCombatantId,
    schedule: ScheduleSchema.parse(JSON.parse(scheduleJson)),
    checkpoint: lastTurnCheckpointJson ? CheckpointSchema.parse(JSON.parse(lastTurnCheckpointJson)) : null,
    combatants: q.select().from(combatants).where(eq(combatants.encounterId, id)).orderBy(rowid).all().map(({ encounterId: _, ...c }) => c),
    conditions: q.select().from(conditions).where(eq(conditions.encounterId, id)).orderBy(rowid).all().map(({ encounterId: _, ...k }) => k),
  };
}

export function saveEncounter(q: Q, s: EncounterState) {
  const { combatants: cs, conditions: ks, activeId, schedule, checkpoint, ...rest } = s;
  const row = {
    ...rest,
    activeCombatantId: activeId,
    scheduleJson: JSON.stringify(schedule),
    lastTurnCheckpointJson: checkpoint ? JSON.stringify(checkpoint) : null,
  };
  q.insert(encounters).values(row).onConflictDoUpdate({ target: encounters.id, set: row }).run();
  q.delete(conditions).where(eq(conditions.encounterId, s.id)).run(); // conditions are replaced wholesale
  for (const c of cs) {
    const values = { ...c, encounterId: s.id };
    q.insert(combatants).values(values).onConflictDoUpdate({ target: combatants.id, set: values }).run();
  }
  for (const k of ks) q.insert(conditions).values({ ...k, encounterId: s.id }).run();
}

export function otherActiveName(q: Q, encounterId: string): string | null {
  return q.select({ name: encounters.name }).from(encounters).where(and(eq(encounters.status, 'active'), ne(encounters.id, encounterId))).get()?.name ?? null;
}

export function listEncounters(q: Q, status: EncounterStatus | undefined, archived: boolean): EncounterSummary[] {
  return q
    .select({
      id: encounters.id, name: encounters.name, status: encounters.status, round: encounters.round,
      archivedAt: encounters.archivedAt, updatedAt: encounters.updatedAt,
      combatantCount: sql<number>`(select count(*) from encounter_combatants c where c.encounter_id = encounters.id and c.removed_at is null)`,
    })
    .from(encounters)
    .where(and(status ? eq(encounters.status, status) : undefined, archived ? isNotNull(encounters.archivedAt) : isNull(encounters.archivedAt)))
    .orderBy(desc(encounters.updatedAt))
    .all();
}

// ---------- templates ----------
type TemplateRow = typeof templates.$inferSelect;

export function toTemplate({ tagsJson, ...row }: TemplateRow): Template {
  return { ...row, tags: JSON.parse(tagsJson) as string[] };
}

export function templateRow(t: Template): TemplateRow {
  const { tags, ...rest } = t;
  return { ...rest, tagsJson: JSON.stringify(tags) };
}

export function loadTemplate(q: Q, id: string): Template | undefined {
  const row = q.select().from(templates).where(eq(templates.id, id)).get();
  return row && toTemplate(row);
}

/** Instance-ready fields of a template (what ADD_COMBATANTS copies). */
export function templateFields(q: Q, id: string): CombatantFields | undefined {
  const t = loadTemplate(q, id);
  if (!t) return undefined;
  const { id: _id, tags: _tags, archivedAt: _a, createdAt: _c, updatedAt: _u, ...fields } = t;
  return fields;
}
