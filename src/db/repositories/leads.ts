import { type Env } from '../env';
import { activities, apiTokens, leads } from '../schema';
import {
  executeAtomically,
  getDatabase,
  id,
  isNotNullViolation,
  isUniqueViolation,
  now,
  prepare,
  type Statement,
} from '../shared';
import {
  getIntakeKey,
  type IntakePersistenceOutcome,
  outcomeForStoredIntakeKey,
} from './intake';
import {
  guardActiveLeadsStatement,
  leadTagStatements,
  parseTagsJson,
  resolveTagPlan,
  tagPlanStatements,
  type TagViewRecord,
} from './tags';
import { type IntakeResponse } from '@/domain/intake';
import { encodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  type CreateLeadRequest,
  type IntakeRequest,
  normalizeEmail,
  type SkippedField,
  type UpdateLeadRequest,
} from '@/domain/schemas';
import { normalizeSourceTag, type TagSpec } from '@/domain/tags';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';

export type LeadPage = {
  leads: LeadRecord[];
  nextCursor: null | string;
};

export type LeadPageOptions = {
  cursor?: Keyset | null;
  limit: number;
  query?: string;
  tagId?: string;
  tagScopeId?: string;
};

export type LeadRecord = {
  createdAt: Date;
  customFields: Record<string, unknown>;
  deletedAt: Date | null;
  duplicateCount: number;
  email: null | string;
  estimatedValue: null | number;
  firstName: null | string;
  id: string;
  lastName: null | string;
  origin: null | string;
  rawPayload?: null | Record<string, unknown>;
  skippedFields: null | SkippedField[];
  source: string;
  tags: TagViewRecord[];
  tokenId: null | string;
  tokenName?: null | string;
  tokenType?: 'api' | 'browser' | null;
  updatedAt: Date;
};

/**
 * Literal, case-insensitive substring match on the email or first/last name.
 * `instr` is used instead of LIKE because D1 caps LIKE/GLOB patterns at 50
 * bytes — an ordinary search string exceeds that once wrapped — and because
 * it removes wildcard escaping entirely, so a literal backslash, `%`, or `_`
 * matches itself.
 */
const leadSearchPredicate = (query: string) => {
  const needle = sql`lower(${query})`;
  return sql`(instr(lower(${leads.email}), ${needle}) > 0 OR instr(lower(${leads.firstName}), ${needle}) > 0 OR instr(lower(${leads.lastName}), ${needle}) > 0)`;
};

/**
 * Count of live leads that share the row's normalized email, including the row
 * itself. Computed in the page/detail query with the leads_email_idx index, so
 * list responses need no second round trip and bind no variable-length email
 * list (D1 caps bound parameters per statement). The outer columns are
 * qualified by hand because Drizzle renders a single-table FROM without a table
 * prefix in a select projection. `toLead` subtracts the row itself to produce
 * the duplicate hint.
 */
const duplicateCountExpression = sql<number>`(
  SELECT count(*) FROM leads AS duplicate
  WHERE duplicate.deleted_at IS NULL
    AND duplicate.email IS NOT NULL
    AND duplicate.email = leads.email
)`;

/**
 * Assigned tags as a JSON array in the SAME list/detail SELECT, so rendering a
 * page never fans out into a per-lead lookup and the page query keeps one
 * statement with a constant number of bound parameters. `COALESCE` keeps the
 * no-tags case as `[]` instead of NULL. Order is applied after parsing.
 */
const tagsJsonExpression = sql<string>`COALESCE((
  SELECT json_group_array(json_object(
    'color', tag.color,
    'createdAt', tag.created_at,
    'id', tag.id,
    'name', tag.name,
    'scopeColor', scope.color,
    'scopeId', tag.scope_id,
    'scopePrefix', scope.prefix,
    'updatedAt', tag.updated_at
  ))
  FROM lead_tags AS assignment
  JOIN tags AS tag ON tag.id = assignment.tag_id
  LEFT JOIN tag_scopes AS scope ON scope.id = tag.scope_id
  WHERE assignment.lead_id = leads.id
), '[]')`;

type LeadListRow = Omit<typeof leads.$inferSelect, 'rawPayload'>;

const toLead = (
  row: LeadListRow & { duplicateCount: number },
  detail: {
    rawPayload?: null | Record<string, unknown>;
    tags?: TagViewRecord[];
    tokenName?: null | string;
    tokenType?: 'api' | 'browser' | null;
  } = {},
): LeadRecord => ({
  createdAt: row.createdAt,
  customFields: row.customFields,
  deletedAt: row.deletedAt,
  duplicateCount: row.email ? Math.max(0, Number(row.duplicateCount) - 1) : 0,
  email: row.email,
  estimatedValue: row.estimatedValue,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  origin: row.origin,
  skippedFields: row.skippedFields ?? null,
  source: row.source,
  tags: detail.tags ?? [],
  tokenId: row.tokenId,
  updatedAt: row.updatedAt,
  ...(detail.rawPayload === undefined ? {} : { rawPayload: detail.rawPayload }),
  ...(detail.tokenName === undefined ? {} : { tokenName: detail.tokenName }),
  ...(detail.tokenType === undefined ? {} : { tokenType: detail.tokenType }),
});

/**
 * Keyset (seek) pagination over (created_at DESC, id DESC), excluding
 * soft-deleted leads. One extra row detects a following page without a COUNT.
 */
export const listLeads = async (
  environment: Env,
  options: LeadPageOptions,
): Promise<LeadPage> => {
  const { cursor, limit, query, tagId, tagScopeId } = options;
  const predicates = [isNull(leads.deletedAt)];
  if (query) {
    predicates.push(leadSearchPredicate(query));
  }

  // Exact-tag and any-tag-in-scope filters are expressions in the same WHERE
  // clause as the keyset cursor, so the page and its count are cut after
  // filtering rather than against only the loaded rows.
  if (tagId) {
    predicates.push(
      sql`EXISTS (SELECT 1 FROM lead_tags AS tag_filter WHERE tag_filter.lead_id = ${leads.id} AND tag_filter.tag_id = ${tagId})`,
    );
  }

  if (tagScopeId) {
    predicates.push(
      sql`EXISTS (SELECT 1 FROM lead_tags AS tag_filter WHERE tag_filter.lead_id = ${leads.id} AND tag_filter.scope_id = ${tagScopeId})`,
    );
  }

  if (cursor) {
    const cursorTime = Date.parse(cursor.createdAt);
    predicates.push(
      sql`(${leads.createdAt} < ${cursorTime} OR (${leads.createdAt} = ${cursorTime} AND ${leads.id} < ${cursor.id}))`,
    );
  }

  const rows = await getDatabase(environment)
    .select({
      createdAt: leads.createdAt,
      customFields: leads.customFields,
      deletedAt: leads.deletedAt,
      duplicateCount: duplicateCountExpression,
      email: leads.email,
      estimatedValue: leads.estimatedValue,
      firstName: leads.firstName,
      id: leads.id,
      lastName: leads.lastName,
      origin: leads.origin,
      skippedFields: leads.skippedFields,
      source: leads.source,
      tagsJson: tagsJsonExpression,
      tokenId: leads.tokenId,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .where(and(...predicates))
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    leads: pageRows.map((row) =>
      toLead(row, { tags: parseTagsJson(row.tagsJson) }),
    ),
    nextCursor:
      hasNextPage && last
        ? encodeKeysetCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
};

export const getLead = async (
  environment: Env,
  leadId: string,
): Promise<LeadRecord | null> => {
  const row = await getDatabase(environment)
    .select({
      ...getTableColumns(leads),
      duplicateCount: duplicateCountExpression,
      tagsJson: tagsJsonExpression,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .get();
  if (!row) {
    return null;
  }

  const token = row.tokenId
    ? await getDatabase(environment)
        .select({ name: apiTokens.name, type: apiTokens.type })
        .from(apiTokens)
        .where(eq(apiTokens.id, row.tokenId))
        .get()
    : undefined;
  return toLead(row, {
    rawPayload: row.rawPayload,
    tags: parseTagsJson(row.tagsJson),
    tokenName: token?.name ?? null,
    tokenType: token?.type ?? null,
  });
};

export const listLeadActivities = async (environment: Env, leadId: string) =>
  getDatabase(environment)
    .select()
    .from(activities)
    .where(eq(activities.leadId, leadId))
    .orderBy(desc(activities.createdAt));

export const createLeadAtomically = async (
  environment: Env,
  input: IntakeRequest,
  idempotencyKey: string,
  requestHash: string,
  provenance?: { origin: null | string; tokenId: null | string },
  rawPayload?: unknown,
  tagSpecs: readonly TagSpec[] = [],
): Promise<IntakePersistenceOutcome> => {
  // Raw D1 binds do not accept Date, so work in Unix milliseconds directly.
  const timestamp = now().getTime();
  const leadId = id();
  const activityId = id();
  const email = normalizeEmail(input.email);
  const response: IntakeResponse = { created: true, leadId };
  const leadStatement = prepare(
    environment.DB,
    `INSERT INTO leads (
        id, email, first_name, last_name,
        source, estimated_value, custom_fields, raw_payload, skipped_fields,
        origin, token_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    leadId,
    email,
    input.firstName ?? null,
    input.lastName ?? null,
    input.source,
    input.estimatedValue ?? null,
    JSON.stringify(input.customFields ?? {}),
    rawPayload === undefined ? null : JSON.stringify(rawPayload),
    input.skippedFields ? JSON.stringify(input.skippedFields) : null,
    provenance?.origin ?? null,
    provenance?.tokenId ?? null,
    timestamp,
    timestamp,
  );
  const activityStatement = prepare(
    environment.DB,
    `INSERT INTO activities (
        id, lead_id, kind, body, metadata, created_at
      ) VALUES (?, ?, 'intake', ?, ?, ?)`,
  ).bind(
    activityId,
    leadId,
    `Received from ${input.source}`,
    JSON.stringify({ source: input.source }),
    timestamp,
  );
  const idempotencyStatement = prepare(
    environment.DB,
    'INSERT INTO idempotency_keys (key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?)',
  ).bind(idempotencyKey, requestHash, JSON.stringify(response), timestamp);
  // Recipient selection and notification are best-effort event work now: the
  // lead and its idempotency row commit here, and the application command
  // publishes `lead.created` only after this function reports a new commit.

  // A concurrent writer can create the same scope/tag between the plan read
  // and the batch, which aborts the whole batch on the unique index. Because
  // the batch is atomic nothing was committed, so a bounded retry re-reads the
  // catalog and rebuilds the plan. New tags stay in the same batch as the
  // lead, so a failure rolls every associated write back.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = await resolveTagPlan(environment, tagSpecs);
    const statements: Statement[] = [
      ...tagPlanStatements(environment, plan, timestamp),
      leadStatement,
      ...leadTagStatements(environment, leadId, plan.assignments, timestamp),
      activityStatement,
      idempotencyStatement,
    ];
    try {
      await executeAtomically(environment.DB, statements);
      return { kind: 'created', response };
    } catch (error) {
      // A unique-key collision on the idempotency row means a concurrent
      // request already committed this key; any other failure committed
      // nothing. Re-read and apply the SAME fingerprint/legacy rules as the
      // fast path — never an unconditional replay.
      const stored = await getIntakeKey(environment, idempotencyKey);
      const outcome = outcomeForStoredIntakeKey(stored, requestHash);
      if (outcome) {
        return outcome;
      }

      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('The intake could not be persisted after tag conflicts.');
};

export const createLead = async (
  environment: Env,
  input: CreateLeadRequest,
  tagSpecs: readonly TagSpec[] = [],
): Promise<LeadRecord> => {
  const ms = now().getTime();
  const leadId = id();
  const email = input.email ? normalizeEmail(input.email) : null;
  const firstName = input.firstName ?? null;
  const lastName = input.lastName ?? null;
  const source = input.source ?? 'Manual entry';
  const estimatedValue = input.estimatedValue ?? null;
  const customFields = input.customFields ?? {};
  const leadStatement = prepare(
    environment.DB,
    `INSERT INTO leads (
        id, email, first_name, last_name,
        source, estimated_value, custom_fields, raw_payload, skipped_fields,
        origin, token_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    leadId,
    email,
    firstName,
    lastName,
    source,
    estimatedValue,
    JSON.stringify(customFields),
    ms,
    ms,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = await resolveTagPlan(environment, tagSpecs);
    const statements: Statement[] = [
      ...tagPlanStatements(environment, plan, ms),
      leadStatement,
      ...leadTagStatements(environment, leadId, plan.assignments, ms),
    ];
    try {
      await executeAtomically(environment.DB, statements);
      break;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  const lead = await getLead(environment, leadId);
  if (!lead) {
    throw new Error('The lead could not be read after creation.');
  }

  return lead;
};

export const updateLead = async (
  environment: Env,
  leadId: string,
  input: UpdateLeadRequest,
): Promise<LeadRecord | null> => {
  const database = getDatabase(environment);
  const existing = await database
    .select({ source: leads.source })
    .from(leads)
    .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
    .get();
  if (!existing) {
    return null;
  }

  const timestamp = now().getTime();
  const assignments = ['updated_at = ?'];
  const binds: Array<null | number | string> = [timestamp];
  if (input.customFields !== undefined) {
    assignments.push('custom_fields = ?');
    binds.push(JSON.stringify(input.customFields));
  }

  if (input.email !== undefined) {
    assignments.push('email = ?');
    binds.push(input.email ? normalizeEmail(input.email) : null);
  }

  if (input.estimatedValue !== undefined) {
    assignments.push('estimated_value = ?');
    binds.push(input.estimatedValue);
  }

  if (input.firstName !== undefined) {
    assignments.push('first_name = ?');
    binds.push(input.firstName);
  }

  if (input.lastName !== undefined) {
    assignments.push('last_name = ?');
    binds.push(input.lastName);
  }

  if (input.source !== undefined && input.source !== existing.source) {
    assignments.push('source = ?');
    binds.push(input.source);
  }

  binds.push(leadId);
  // Patch-specific UPDATE: fields absent from the request are left untouched,
  // so a concurrent edit to another field is never clobbered by a stale read.
  const updateStatement = prepare(
    environment.DB,
    `UPDATE leads SET ${assignments.join(', ')}
      WHERE id = ? AND deleted_at IS NULL`,
  ).bind(...binds);

  const newSource = input.source;
  if (newSource === undefined || newSource === existing.source) {
    // No source change means no classification write: a legacy PATCH that only
    // touches contact fields can never rewrite the lead's source:* tag.
    const result = await updateStatement.run();
    return (result.meta?.changes ?? 0) > 0
      ? getLead(environment, leadId)
      : null;
  }

  // The source actually changed: reconcile the source:* classification in the
  // same atomic batch as the lead update. The raw intake payload, provenance
  // and the legacy `source` column keep their truth; only the classification
  // tag is replaced. Mapping legacy source values is lossless and matches the
  // 0003 backfill's `lower(trim(...))` normalization.
  const sourceSpec: TagSpec = {
    name: normalizeSourceTag(newSource),
    prefix: 'source',
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = await resolveTagPlan(environment, [sourceSpec]);
    const statements: Statement[] = [
      // Aborts the batch if the lead disappeared after the read.
      guardActiveLeadsStatement(environment, [leadId], timestamp),
      updateStatement,
      ...tagPlanStatements(environment, plan, timestamp),
      prepare(
        environment.DB,
        `DELETE FROM lead_tags
          WHERE lead_id = ?
            AND scope_id IN (
              SELECT id FROM tag_scopes
              WHERE prefix = 'source'
            )`,
      ).bind(leadId),
      ...leadTagStatements(environment, leadId, plan.assignments, timestamp),
    ];
    try {
      await executeAtomically(environment.DB, statements);
      return getLead(environment, leadId);
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      if (isNotNullViolation(error)) {
        // The lead was deleted between the read and the batch; the guard
        // aborted the whole batch, so nothing was written.
        return null;
      }

      throw error;
    }
  }

  throw new Error('The lead source could not be reconciled after retries.');
};

export const softDeleteLeads = async (
  environment: Env,
  ids: readonly string[],
): Promise<number> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return 0;
  }

  // One statement stays atomic without a batch, and the id list travels as a
  // single JSON array parameter, so no variable-length binding can hit D1's
  // 100-parameter cap. json_each is the documented D1 pattern for IN queries:
  // https://developers.cloudflare.com/d1/sql-api/query-json/#expand-arrays-for-in-queries
  const result = await getDatabase(environment)
    .update(leads)
    .set({ deletedAt: now() })
    .where(
      and(
        isNull(leads.deletedAt),
        sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`,
      ),
    )
    .run();
  return result.meta.changes;
};

export const createLeadActivity = async (
  environment: Env,
  leadId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => {
  const lead = await getLead(environment, leadId);
  if (!lead) {
    return null;
  }

  const record = {
    actorEmail,
    body,
    createdAt: now(),
    id: id(),
    kind,
    leadId,
    metadata: {},
  };
  await getDatabase(environment).insert(activities).values(record);
  return record;
};
