import { type Env } from '../../env';
import { leads, tags, tagScopes } from '../../schema';
import { getDatabase, id, prepare, type Statement } from '../../shared';
import { nextTagColor } from './shared';
import { type TagColor } from '@/domain/schemas';
import { type TagSpec } from '@/domain/tags';
import { and, isNull, sql } from 'drizzle-orm';

export type TagPlan = {
  assignments: Array<{ scopeId: null | string; tagId: string }>;
  newScopes: Array<{ color: TagColor; id: string; prefix: string }>;
  newTags: Array<{
    color: null | TagColor;
    id: string;
    name: string;
    scopeId: null | string;
  }>;
};

/**
 * Deterministic last-in-payload-wins: a later scoped tag replaces an earlier
 * sibling in the same scope; standalone tags de-duplicate by name.
 */
const dedupeTagSpecs = (specs: readonly TagSpec[]): TagSpec[] => {
  const result: TagSpec[] = [];
  const scoped = new Map<string, number>();
  const standalone = new Set<string>();
  for (const spec of specs) {
    if (spec.prefix) {
      const index = scoped.get(spec.prefix);
      if (index === undefined) {
        scoped.set(spec.prefix, result.length);
        result.push(spec);
      } else {
        result[index] = spec;
      }
    } else if (!standalone.has(spec.name)) {
      standalone.add(spec.name);
      result.push(spec);
    }
  }

  return result;
};

/**
 * Reads the current catalog and plans the scopes/tags needed for a set of
 * specs. Existing rows keep their ids; missing rows get ids generated here so
 * the caller can reference them in one atomic batch. A concurrent writer can
 * still win the unique index, which the caller retries against the re-read
 * catalog.
 */
export const resolveTagPlan = async (
  environment: Env,
  specs: readonly TagSpec[],
): Promise<TagPlan> => {
  const deduped = dedupeTagSpecs(specs);
  const database = getDatabase(environment);
  const scopeRows = await database
    .select({ id: tagScopes.id, prefix: tagScopes.prefix })
    .from(tagScopes);
  const tagRows = await database
    .select({ id: tags.id, name: tags.name, scopeId: tags.scopeId })
    .from(tags);
  const scopesByPrefix = new Map<string, string>(
    scopeRows.map((row) => [row.prefix, row.id]),
  );
  const tagsByKey = new Map<string, string>(
    tagRows.map((row) => [`${row.scopeId ?? ''}\u0000${row.name}`, row.id]),
  );

  const newScopes: TagPlan['newScopes'] = [];
  const newTags: TagPlan['newTags'] = [];
  const assignments: TagPlan['assignments'] = [];
  for (const spec of deduped) {
    let scopeId: null | string = null;
    if (spec.prefix) {
      const existingScope = scopesByPrefix.get(spec.prefix);
      if (existingScope === undefined) {
        const plannedScope = newScopes.find(
          (scope) => scope.prefix === spec.prefix,
        );
        if (plannedScope) {
          scopeId = plannedScope.id;
        } else {
          scopeId = id();
          newScopes.push({
            color: nextTagColor(scopeRows.length + newScopes.length),
            id: scopeId,
            prefix: spec.prefix,
          });
        }
      } else {
        scopeId = existingScope;
      }
    }

    const key = `${scopeId ?? ''}\u0000${spec.name}`;
    let tagId = tagsByKey.get(key);
    if (tagId === undefined) {
      const plannedTag = newTags.find(
        (tag) => tag.scopeId === scopeId && tag.name === spec.name,
      );
      if (plannedTag) {
        tagId = plannedTag.id;
      } else {
        tagId = id();
        newTags.push({
          color: scopeId ? null : nextTagColor(tagRows.length + newTags.length),
          id: tagId,
          name: spec.name,
          scopeId,
        });
      }
    }

    assignments.push({ scopeId, tagId });
  }

  return { assignments, newScopes, newTags };
};

export const tagPlanStatements = (
  environment: Env,
  plan: TagPlan,
  timestamp: number,
): Statement[] => [
  ...plan.newScopes.map((scope) =>
    prepare(
      environment.DB,
      'INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(scope.id, scope.prefix, scope.color, timestamp, timestamp),
  ),
  ...plan.newTags.map((tag) =>
    prepare(
      environment.DB,
      'INSERT INTO tags (id, name, scope_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(tag.id, tag.name, tag.scopeId, tag.color, timestamp, timestamp),
  ),
];

export const leadTagStatements = (
  environment: Env,
  leadId: string,
  assignments: TagPlan['assignments'],
  timestamp: number,
): Statement[] =>
  assignments.map((assignment) =>
    prepare(
      environment.DB,
      `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
        VALUES (?, ?, ?, (
          SELECT scope_id FROM tags WHERE id = ?
        ), ?)`,
    ).bind(id(), leadId, assignment.tagId, assignment.tagId, timestamp),
  );

/**
 * Transaction-time guard: aborts the enclosing batch (NOT NULL violation) when
 * any requested lead is missing or soft-deleted at write time. A pre-write
 * read is only a fast path; this closes the window between that read and the
 * batch so a bulk write can never silently skip a lead.
 */
export const guardActiveLeadsStatement = (
  environment: Env,
  leadIds: readonly string[],
  timestamp: number,
): Statement =>
  prepare(
    environment.DB,
    `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
      SELECT
        '0' || substr(hex(randomblob(13)), 1, 25),
        requested.value,
        NULL,
        NULL,
        ?
      FROM json_each(?) AS requested
      WHERE NOT EXISTS (
        SELECT 1 FROM leads
        WHERE id = requested.value
          AND deleted_at IS NULL
      )`,
  ).bind(timestamp, JSON.stringify(leadIds));

/**
 * Transaction-time guard: aborts the enclosing batch when any requested tag no
 * longer exists at write time. The NULL `lead_id` is the deliberate violating
 * value; when every tag exists the SELECT produces no rows.
 */
export const guardExistingTagsStatement = (
  environment: Env,
  tagIds: readonly string[],
  timestamp: number,
): Statement =>
  prepare(
    environment.DB,
    `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
      SELECT
        '0' || substr(hex(randomblob(13)), 1, 25),
        NULL,
        NULL,
        NULL,
        ?
      FROM json_each(?) AS requested
      WHERE NOT EXISTS (
        SELECT 1 FROM tags
        WHERE id = requested.value
      )`,
  ).bind(timestamp, JSON.stringify(tagIds));

export const missingActiveLeadIds = async (
  environment: Env,
  leadIds: readonly string[],
): Promise<string[]> => {
  if (leadIds.length === 0) {
    return [];
  }

  const rows = await getDatabase(environment)
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        isNull(leads.deletedAt),
        sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(leadIds)}))`,
      ),
    );
  const present = new Set(rows.map((row) => row.id));
  return leadIds.filter((leadId) => !present.has(leadId));
};

export const missingTagIds = async (
  environment: Env,
  tagIds: readonly string[],
): Promise<string[]> => {
  if (tagIds.length === 0) {
    return [];
  }

  const rows = await getDatabase(environment)
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        sql`${tags.id} IN (SELECT value FROM json_each(${JSON.stringify(tagIds)}))`,
      ),
    );
  const present = new Set(rows.map((row) => row.id));
  return tagIds.filter((tagId) => !present.has(tagId));
};
