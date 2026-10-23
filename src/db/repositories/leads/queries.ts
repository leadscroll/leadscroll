import { type Env } from '../../env';
import { activities, apiTokens, leads } from '../../schema';
import { getDatabase } from '../../shared';
import { parseTagsJson } from '../tags';
import {
  duplicateCountExpression,
  type LeadPage,
  type LeadPageOptions,
  type LeadRecord,
  leadSearchPredicate,
  tagsJsonExpression,
  toLead,
} from './shared';
import { encodeKeysetCursor } from '@/domain/pagination';
import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';

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
