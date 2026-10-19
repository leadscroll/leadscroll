import { type Env } from '../env';
import { leads, leadTags, tags, tagScopes } from '../schema';
import {
  executeAtomically,
  executeAtomicallyWithResults,
  getDatabase,
  id,
  isNotNullViolation,
  isUniqueViolation,
  now,
  prepare,
  type Statement,
  uniqueConstraintTarget,
} from '../shared';
import { type TagColor } from '@/domain/schemas';
import { tagLabel, type TagSpec } from '@/domain/tags';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

export type CatalogTagRecord = TagViewRecord & { leadCount: number };

export type TagScopeRecord = {
  color: TagColor;
  createdAt: Date;
  id: string;
  prefix: string;
  updatedAt: Date;
};

export type TagViewRecord = {
  color: TagColor;
  createdAt: Date;
  id: string;
  label: string;
  name: string;
  scopeId: null | string;
  updatedAt: Date;
};

const TAG_PALETTE = [
  'teal',
  'blue',
  'violet',
  'amber',
] as const satisfies readonly TagColor[];

const nextTagColor = (count: number): TagColor =>
  TAG_PALETTE[count % TAG_PALETTE.length] ?? 'teal';

const asTagColor = (value: null | string): TagColor =>
  TAG_PALETTE.includes(value as TagColor) ? (value as TagColor) : 'teal';

type TagRowWithScope = {
  color: null | string;
  createdAt: Date;
  id: string;
  name: string;
  scopeColor: null | string;
  scopeId: null | string;
  scopePrefix: null | string;
  updatedAt: Date;
};

const toTagViewRecord = (row: TagRowWithScope): TagViewRecord => ({
  color: asTagColor(row.scopeColor ?? row.color),
  createdAt: row.createdAt,
  id: row.id,
  label: tagLabel(row.name, row.scopePrefix),
  name: row.name,
  scopeId: row.scopeId,
  updatedAt: row.updatedAt,
});

export const parseTagsJson = (value: null | string): TagViewRecord[] => {
  if (!value) {
    return [];
  }

  try {
    const rows = JSON.parse(value) as Array<
      Omit<TagRowWithScope, 'createdAt' | 'updatedAt'> & {
        createdAt: number;
        updatedAt: number;
      }
    >;
    return rows
      .map((row) =>
        toTagViewRecord({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        }),
      )
      .toSorted((left, right) => left.label.localeCompare(right.label));
  } catch {
    return [];
  }
};

/**
 * Loads the assigned tag views for a bounded set of lead ids in one query, so
 * a list page or detail read never fans out into a per-row lookup.
 */
const tagViewsForLeads = async (
  database: ReturnType<typeof getDatabase>,
  leadIds: readonly string[],
): Promise<Map<string, TagViewRecord[]>> => {
  const result = new Map<string, TagViewRecord[]>();
  if (leadIds.length === 0) {
    return result;
  }

  const rows = await database
    .select({
      color: tags.color,
      createdAt: tags.createdAt,
      id: tags.id,
      leadId: leadTags.leadId,
      name: tags.name,
      scopeColor: tagScopes.color,
      scopeId: tags.scopeId,
      scopePrefix: tagScopes.prefix,
      updatedAt: tags.updatedAt,
    })
    .from(leadTags)
    .innerJoin(tags, eq(tags.id, leadTags.tagId))
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId))
    .where(
      and(
        sql`${leadTags.leadId} IN (SELECT value FROM json_each(${JSON.stringify(leadIds)}))`,
      ),
    )
    .orderBy(asc(tags.name));

  for (const row of rows) {
    const list = result.get(row.leadId) ?? [];
    list.push(toTagViewRecord(row));
    result.set(row.leadId, list);
  }

  return result;
};

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
const guardExistingTagsStatement = (
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

const missingActiveLeadIds = async (
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

const missingTagIds = async (
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

const tagViewSelect = {
  color: tags.color,
  createdAt: tags.createdAt,
  id: tags.id,
  name: tags.name,
  scopeColor: tagScopes.color,
  scopeId: tags.scopeId,
  scopePrefix: tagScopes.prefix,
  updatedAt: tags.updatedAt,
} as const;

const getTagView = async (
  environment: Env,
  tagId: string,
): Promise<TagViewRecord | undefined> => {
  const row = await getDatabase(environment)
    .select(tagViewSelect)
    .from(tags)
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId))
    .where(eq(tags.id, tagId))
    .get();
  return row ? toTagViewRecord(row) : undefined;
};

const getScopeView = async (
  environment: Env,
  scopeId: string,
): Promise<TagScopeRecord | undefined> => {
  const row = await getDatabase(environment)
    .select()
    .from(tagScopes)
    .where(eq(tagScopes.id, scopeId))
    .get();
  return row
    ? {
        color: asTagColor(row.color),
        createdAt: row.createdAt,
        id: row.id,
        prefix: row.prefix,
        updatedAt: row.updatedAt,
      }
    : undefined;
};

export const listTagCatalog = async (
  environment: Env,
): Promise<{ scopes: TagScopeRecord[]; tags: CatalogTagRecord[] }> => {
  const database = getDatabase(environment);
  const scopeRows = await database
    .select()
    .from(tagScopes)
    .orderBy(asc(tagScopes.prefix));
  const tagRows = await database
    .select({
      ...tagViewSelect,
      leadCount: sql<number>`(SELECT count(*) FROM lead_tags AS usage JOIN leads AS used ON used.id = usage.lead_id WHERE usage.tag_id = ${tags.id} AND used.deleted_at IS NULL)`,
    })
    .from(tags)
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId));

  return {
    scopes: scopeRows.map((row) => ({
      color: asTagColor(row.color),
      createdAt: row.createdAt,
      id: row.id,
      prefix: row.prefix,
      updatedAt: row.updatedAt,
    })),
    tags: tagRows
      .map((row) => ({
        ...toTagViewRecord(row),
        leadCount: Number(row.leadCount),
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label)),
  };
};

export type TagMutationOutcome =
  | {
      code: 'scope_conflict' | 'scope_exists' | 'tag_exists';
      kind: 'conflict';
      message: string;
    }
  | { kind: 'not-found' }
  | { kind: 'ok'; tag: TagViewRecord };

const tagConflict = (
  target: null | string,
): Extract<TagMutationOutcome, { kind: 'conflict' }> => {
  if (target?.startsWith('lead_tags')) {
    return {
      code: 'scope_conflict',
      kind: 'conflict',
      message:
        'Some assigned leads already have another tag in that scope. Resolve those conflicts before moving this tag.',
    };
  }

  if (target?.startsWith('tag_scopes')) {
    return {
      code: 'scope_exists',
      kind: 'conflict',
      message: 'That scope already exists. Choose another prefix.',
    };
  }

  return {
    code: 'tag_exists',
    kind: 'conflict',
    message: 'That tag already exists. Choose another name.',
  };
};

const findTagBySpec = async (
  environment: Env,
  scopeId: null | string,
  name: string,
) =>
  getDatabase(environment)
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        scopeId === null ? isNull(tags.scopeId) : eq(tags.scopeId, scopeId),
        eq(tags.name, name),
      ),
    )
    .get();

export const createTag = async (
  environment: Env,
  spec: TagSpec,
): Promise<TagMutationOutcome> => {
  const database = getDatabase(environment);
  const scope = spec.prefix
    ? await database
        .select()
        .from(tagScopes)
        .where(eq(tagScopes.prefix, spec.prefix))
        .get()
    : undefined;
  const scopeId = scope?.id ?? null;
  if (await findTagBySpec(environment, scopeId, spec.name)) {
    return tagConflict('tags.name_scope');
  }

  const scopeCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(tagScopes)
    .get();
  const tagCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(tags)
    .get();
  const timestamp = now().getTime();
  const effectiveScopeId = spec.prefix ? (scopeId ?? id()) : null;
  const tagId = id();
  const statements: Statement[] = [];
  if (spec.prefix && !scope) {
    statements.push(
      prepare(
        environment.DB,
        'INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(
        effectiveScopeId,
        spec.prefix,
        nextTagColor(Number(scopeCount?.count ?? 0)),
        timestamp,
        timestamp,
      ),
    );
  }

  statements.push(
    prepare(
      environment.DB,
      'INSERT INTO tags (id, name, scope_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      tagId,
      spec.name,
      effectiveScopeId,
      effectiveScopeId ? null : nextTagColor(Number(tagCount?.count ?? 0)),
      timestamp,
      timestamp,
    ),
  );

  try {
    await executeAtomically(environment.DB, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return tagConflict(uniqueConstraintTarget(error));
    }

    throw error;
  }

  const tag = await getTagView(environment, tagId);
  return tag ? { kind: 'ok', tag } : { kind: 'not-found' };
};

export const updateTag = async (
  environment: Env,
  tagId: string,
  patch: { color?: TagColor; name?: TagSpec },
): Promise<TagMutationOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select()
    .from(tags)
    .where(eq(tags.id, tagId))
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  const timestamp = now().getTime();
  const statements: Statement[] = [];
  let targetScopeId: null | string = current.scopeId;
  let targetColor = current.color;
  let oldScopeId: null | string = null;
  let moved = false;

  if (patch.name) {
    if (patch.name.prefix) {
      const scope = await database
        .select()
        .from(tagScopes)
        .where(eq(tagScopes.prefix, patch.name.prefix))
        .get();
      if (scope) {
        targetScopeId = scope.id;
      } else {
        targetScopeId = id();
        const scopeCount = await database
          .select({ count: sql<number>`count(*)` })
          .from(tagScopes)
          .get();
        statements.push(
          prepare(
            environment.DB,
            'INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          ).bind(
            targetScopeId,
            patch.name.prefix,
            nextTagColor(Number(scopeCount?.count ?? 0)),
            timestamp,
            timestamp,
          ),
        );
      }
    } else {
      targetScopeId = null;
      if (!targetColor) {
        const tagCount = await database
          .select({ count: sql<number>`count(*)` })
          .from(tags)
          .get();
        targetColor = nextTagColor(Number(tagCount?.count ?? 0));
      }
    }

    moved = targetScopeId !== current.scopeId;
    oldScopeId = current.scopeId;

    statements.push(
      prepare(
        environment.DB,
        'UPDATE tags SET name = ?, scope_id = ?, color = ?, updated_at = ? WHERE id = ?',
      ).bind(patch.name.name, targetScopeId, targetColor, timestamp, tagId),
    );
    // Always reconcile the denormalized join scope to the tag's actual scope
    // inside the same batch. Comparing only against the read snapshot is
    // unsound: if a concurrent move committed between the read and this batch,
    // `moved` would be false and the tag could be written back to the snapshot
    // scope while its joins stayed on the other scope.
    statements.push(
      prepare(
        environment.DB,
        `UPDATE lead_tags
          SET scope_id = (SELECT scope_id FROM tags WHERE id = ?)
          WHERE tag_id = ?`,
      ).bind(tagId, tagId),
    );
  }

  if (patch.color) {
    if (targetScopeId) {
      statements.push(
        prepare(
          environment.DB,
          'UPDATE tag_scopes SET color = ?, updated_at = ? WHERE id = ?',
        ).bind(patch.color, timestamp, targetScopeId),
      );
    } else {
      statements.push(
        prepare(
          environment.DB,
          'UPDATE tags SET color = ?, updated_at = ? WHERE id = ?',
        ).bind(patch.color, timestamp, tagId),
      );
    }
  }

  if (moved && oldScopeId) {
    // An inferred scope is pruned once its final tag has moved out. The
    // NOT EXISTS guard keeps this safe even if a concurrent writer repopulated
    // the snapshot scope after our read.
    statements.push(
      prepare(
        environment.DB,
        'DELETE FROM tag_scopes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tags WHERE scope_id = ?)',
      ).bind(oldScopeId, oldScopeId),
    );
  }

  if (statements.length === 0) {
    const unchanged = await getTagView(environment, tagId);
    return unchanged ? { kind: 'ok', tag: unchanged } : { kind: 'not-found' };
  }

  try {
    await executeAtomically(environment.DB, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return tagConflict(uniqueConstraintTarget(error));
    }

    throw error;
  }

  const tag = await getTagView(environment, tagId);
  return tag ? { kind: 'ok', tag } : { kind: 'not-found' };
};

export type TagScopeMutationOutcome =
  | {
      code: 'scope_exists';
      kind: 'conflict';
      message: string;
    }
  | { kind: 'not-found' }
  | { kind: 'ok'; scope: TagScopeRecord };

export const updateTagScope = async (
  environment: Env,
  scopeId: string,
  patch: { color?: TagColor; prefix?: string },
): Promise<TagScopeMutationOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select()
    .from(tagScopes)
    .where(eq(tagScopes.id, scopeId))
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  try {
    await executeAtomically(environment.DB, [
      prepare(
        environment.DB,
        'UPDATE tag_scopes SET color = ?, prefix = ?, updated_at = ? WHERE id = ?',
      ).bind(
        patch.color ?? asTagColor(current.color),
        patch.prefix ?? current.prefix,
        now().getTime(),
        scopeId,
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        code: 'scope_exists',
        kind: 'conflict',
        message: 'That scope already exists. Choose another name.',
      };
    }

    throw error;
  }

  const scope = await getScopeView(environment, scopeId);
  return scope ? { kind: 'ok', scope } : { kind: 'not-found' };
};

export type DeleteTagOutcome =
  { kind: 'deleted'; removed: number } | { kind: 'not-found' };

export const deleteTag = async (
  environment: Env,
  tagId: string,
): Promise<DeleteTagOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select({ scopeId: tags.scopeId })
    .from(tags)
    .where(eq(tags.id, tagId))
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  const removed = await database
    .select({ count: sql<number>`count(*)` })
    .from(leadTags)
    .innerJoin(leads, eq(leads.id, leadTags.leadId))
    .where(and(eq(leadTags.tagId, tagId), isNull(leads.deletedAt)))
    .get();
  const statements: Statement[] = [
    prepare(environment.DB, 'DELETE FROM lead_tags WHERE tag_id = ?').bind(
      tagId,
    ),
    prepare(environment.DB, 'DELETE FROM tags WHERE id = ?').bind(tagId),
  ];
  if (current.scopeId) {
    statements.push(
      prepare(
        environment.DB,
        'DELETE FROM tag_scopes WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tags WHERE scope_id = ?)',
      ).bind(current.scopeId, current.scopeId),
    );
  }

  await executeAtomically(environment.DB, statements);
  return { kind: 'deleted', removed: Number(removed?.count ?? 0) };
};

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
