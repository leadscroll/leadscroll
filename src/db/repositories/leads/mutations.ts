import { type Env } from '../../env';
import { activities, leads } from '../../schema';
import {
  executeAtomically,
  getDatabase,
  id,
  isNotNullViolation,
  isUniqueViolation,
  now,
  prepare,
  type Statement,
} from '../../shared';
import {
  getIntakeKey,
  type IntakePersistenceOutcome,
  outcomeForStoredIntakeKey,
} from '../intake';
import {
  guardActiveLeadsStatement,
  leadTagStatements,
  resolveTagPlan,
  tagPlanStatements,
} from '../tags';
import { getLead } from './queries';
import { type LeadRecord } from './shared';
import { type IntakeResponse } from '@/domain/intake';
import {
  type CreateLeadRequest,
  type IntakeRequest,
  normalizeEmail,
  type UpdateLeadRequest,
} from '@/domain/schemas';
import { normalizeSourceTag, type TagSpec } from '@/domain/tags';
import { and, eq, isNull, sql } from 'drizzle-orm';

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
