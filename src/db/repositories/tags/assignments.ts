import { type Env } from '../../env';
import { leads, tags } from '../../schema';
import {
  executeAtomically,
  executeAtomicallyWithResults,
  getDatabase,
  isNotNullViolation,
  isUniqueViolation,
  now,
  prepare,
  type Statement,
} from '../../shared';
import {
  guardActiveLeadsStatement,
  guardExistingTagsStatement,
  leadTagStatements,
  missingActiveLeadIds,
  missingTagIds,
  type TagPlan,
} from './planning';
import { type TagViewRecord, tagViewsForLeads } from './shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

const resolveAssignmentsByIds = async (
  environment: Env,
  tagIds: readonly string[],
): Promise<{
  assignments: TagPlan['assignments'];
  unknown: string[];
}> => {
  const unique = [...new Set(tagIds.toReversed())].toReversed();
  if (unique.length === 0) {
    return { assignments: [], unknown: [] };
  }

  const rows = await getDatabase(environment)
    .select({ id: tags.id, scopeId: tags.scopeId })
    .from(tags)
    .where(
      and(
        sql`${tags.id} IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`,
      ),
    );
  const byId = new Map<string, null | string>(
    rows.map((row) => [row.id, row.scopeId]),
  );
  const unknown = unique.filter((tagId) => !byId.has(tagId));
  const assignments: TagPlan['assignments'] = [];
  const scopeIndex = new Map<string, number>();
  for (const tagId of unique) {
    const scopeId = byId.get(tagId);
    if (scopeId === undefined) {
      continue;
    }

    if (scopeId === null) {
      assignments.push({ scopeId, tagId });
    } else {
      const index = scopeIndex.get(scopeId);
      if (index === undefined) {
        scopeIndex.set(scopeId, assignments.length);
        assignments.push({ scopeId, tagId });
      } else {
        // Last-in-list wins within an exclusive scope.
        assignments[index] = { scopeId, tagId };
      }
    }
  }

  return { assignments, unknown };
};

export type SetLeadTagsOutcome =
  | { kind: 'not-found' }
  | { kind: 'ok'; tags: TagViewRecord[] }
  | { kind: 'unknown-tag'; tagIds: string[] };

export const setLeadTags = async (
  environment: Env,
  leadId: string,
  tagIds: readonly string[],
): Promise<SetLeadTagsOutcome> => {
  const database = getDatabase(environment);
  const lead = await database
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .get();
  if (!lead) {
    return { kind: 'not-found' };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolved = await resolveAssignmentsByIds(environment, tagIds);
    if (resolved.unknown.length > 0) {
      return { kind: 'unknown-tag', tagIds: resolved.unknown };
    }

    const statements: Statement[] = [
      prepare(environment.DB, 'DELETE FROM lead_tags WHERE lead_id = ?').bind(
        leadId,
      ),
      ...leadTagStatements(
        environment,
        leadId,
        resolved.assignments,
        now().getTime(),
      ),
    ];
    try {
      await executeAtomically(environment.DB, statements);
      const map = await tagViewsForLeads(database, [leadId]);
      return { kind: 'ok', tags: map.get(leadId) ?? [] };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('The lead tags could not be saved after retries.');
};

export type BulkTagOutcome =
  | { affected: number; kind: 'ok' }
  | { kind: 'unknown-lead'; leadIds: string[] }
  | { kind: 'unknown-tag'; tagIds: string[] };

/**
 * Translates a transaction-time guard abort into the specific missing
 * lead/tag outcome. Any other failure is rethrown; the caller never reports a
 * silent partial success.
 */
const mapBulkRaceError = async (
  environment: Env,
  leadIds: readonly string[],
  tagIds: readonly string[],
  error: unknown,
): Promise<BulkTagOutcome> => {
  if (isNotNullViolation(error)) {
    const missingLeads = await missingActiveLeadIds(environment, leadIds);
    if (missingLeads.length > 0) {
      return { kind: 'unknown-lead', leadIds: missingLeads };
    }

    const missingTags = await missingTagIds(environment, tagIds);
    if (missingTags.length > 0) {
      return { kind: 'unknown-tag', tagIds: missingTags };
    }
  }

  throw error;
};

export const bulkTag = async (
  environment: Env,
  leadIds: readonly string[],
  tagIds: readonly string[],
  mode: 'add' | 'remove',
): Promise<BulkTagOutcome> => {
  const uniqueLeads = [...new Set(leadIds)];
  const uniqueTags = [...new Set(tagIds.toReversed())].toReversed();

  // Fast path with a useful error; the batch guards below are the real
  // safety net if a lead/tag disappears between this read and the write.
  const missingLeads = await missingActiveLeadIds(environment, uniqueLeads);
  if (missingLeads.length > 0) {
    return { kind: 'unknown-lead', leadIds: missingLeads };
  }

  const missingTags = await missingTagIds(environment, uniqueTags);
  if (missingTags.length > 0) {
    return { kind: 'unknown-tag', tagIds: missingTags };
  }

  const timestamp = now().getTime();

  if (mode === 'remove') {
    const statements: Statement[] = [
      guardActiveLeadsStatement(environment, uniqueLeads, timestamp),
      guardExistingTagsStatement(environment, uniqueTags, timestamp),
      prepare(
        environment.DB,
        `DELETE FROM lead_tags
          WHERE lead_id IN (SELECT value FROM json_each(?))
            AND tag_id IN (SELECT value FROM json_each(?))
          RETURNING lead_id AS leadId`,
      ).bind(JSON.stringify(uniqueLeads), JSON.stringify(uniqueTags)),
    ];
    try {
      const results = await executeAtomicallyWithResults(
        environment.DB,
        statements,
      );
      const removed = (results.at(-1)?.results ?? []) as Array<{
        leadId: string;
      }>;
      // `affected` is distinct leads changed, never the deleted join count.
      return {
        affected: new Set(removed.map((row) => row.leadId)).size,
        kind: 'ok',
      };
    } catch (error) {
      return await mapBulkRaceError(
        environment,
        uniqueLeads,
        uniqueTags,
        error,
      );
    }
  }

  // Retry only when a concurrent catalog move makes the resolved winners
  // collide; a guard abort is translated below, not retried.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolved = await resolveAssignmentsByIds(environment, uniqueTags);
    if (resolved.unknown.length > 0) {
      return { kind: 'unknown-tag', tagIds: resolved.unknown };
    }

    // Insert only the deterministic last-wins winners. Inserting the raw
    // request would place two same-scope rows on a lead and violate the
    // exclusivity index.
    const winnerTagIds = resolved.assignments.map(
      (assignment) => assignment.tagId,
    );
    const statements: Statement[] = [
      guardActiveLeadsStatement(environment, uniqueLeads, timestamp),
      guardExistingTagsStatement(environment, uniqueTags, timestamp),
      prepare(
        environment.DB,
        `DELETE FROM lead_tags
          WHERE lead_id IN (SELECT value FROM json_each(?))
            AND (
              tag_id IN (SELECT value FROM json_each(?))
              OR scope_id IN (
                SELECT scope_id FROM tags
                WHERE id IN (SELECT value FROM json_each(?))
              )
            )`,
      ).bind(
        JSON.stringify(uniqueLeads),
        JSON.stringify(winnerTagIds),
        JSON.stringify(winnerTagIds),
      ),
      prepare(
        environment.DB,
        `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
          SELECT
            '0' || substr(hex(randomblob(13)), 1, 25),
            l.id,
            tag.id,
            tag.scope_id,
            ?
          FROM json_each(?) AS ids
          JOIN leads AS l
            ON l.id = ids.value
            AND l.deleted_at IS NULL
          CROSS JOIN json_each(?) AS tids
          JOIN tags AS tag
            ON tag.id = tids.value
          RETURNING lead_id AS leadId`,
      ).bind(
        timestamp,
        JSON.stringify(uniqueLeads),
        JSON.stringify(winnerTagIds),
      ),
    ];
    try {
      const results = await executeAtomicallyWithResults(
        environment.DB,
        statements,
      );
      const inserted = (results.at(-1)?.results ?? []) as Array<{
        leadId: string;
      }>;
      // `affected` is distinct leads changed, never the inserted join count.
      return {
        affected: new Set(inserted.map((row) => row.leadId)).size,
        kind: 'ok',
      };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      return await mapBulkRaceError(
        environment,
        uniqueLeads,
        uniqueTags,
        error,
      );
    }
  }

  throw new Error('The bulk tag update could not be applied after retries.');
};
