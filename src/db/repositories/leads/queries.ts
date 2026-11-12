import { type Env } from '../../env';
import { activities, apiTokens, leads } from '../../schema';
import { getDatabase } from '../../shared';
import { parseTagsJson } from '../tags';
import {
  duplicateCountExpression,
  type LeadExportPage,
  type LeadExportPageOptions,
  type LeadFilterOptions,
  leadFilterPredicates,
  leadKeysetPredicate,
  type LeadPage,
  type LeadPageOptions,
  type LeadRecord,
  tagsJsonExpression,
  toLead,
} from './shared';
import { encodeKeysetCursor } from '@/domain/pagination';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';

export const listLeads = async (
  environment: Env,
  options: LeadPageOptions,
): Promise<LeadPage> => {
  const { cursor, limit } = options;
  // Exact-tag and any-tag-in-scope filters are expressions in the same WHERE
  // clause as the keyset cursor, so the page and its count are cut after
  // filtering rather than against only the loaded rows.
  const predicates = leadFilterPredicates(options);
  if (cursor) {
    predicates.push(leadKeysetPredicate(cursor));
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

/**
 * Reads the same filtered live-lead set as the list, but with only the fields
 * the CSV export needs. The page limit is owned by the export service, not by
 * the public list contract.
 */
export const listLeadExportPage = async (
  environment: Env,
  options: LeadExportPageOptions,
): Promise<LeadExportPage> => {
  const { cursor, limit } = options;
  const predicates = leadFilterPredicates(options);
  if (cursor) {
    predicates.push(leadKeysetPredicate(cursor));
  }

  const rows = await getDatabase(environment)
    .select({
      createdAt: leads.createdAt,
      customFields: leads.customFields,
      email: leads.email,
      estimatedValue: leads.estimatedValue,
      firstName: leads.firstName,
      id: leads.id,
      lastName: leads.lastName,
      origin: leads.origin,
      source: leads.source,
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
    nextCursor:
      hasNextPage && last
        ? encodeKeysetCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
    rows: pageRows,
  };
};

/**
 * Distinct custom-field keys for the filtered live-lead set, used to plan the
 * dynamic export columns before any row is written. Only keys leave D1; the
 * row values are still streamed separately.
 */
export const listLeadCustomFieldKeys = async (
  environment: Env,
  options: LeadFilterOptions,
): Promise<string[]> => {
  const predicates = leadFilterPredicates(options);
  const rows = await getDatabase(environment).all<{ key: string }>(
    sql`
      SELECT DISTINCT json_each.key AS key
      FROM leads, json_each(leads.custom_fields)
      WHERE ${and(...predicates)}
      ORDER BY json_each.key COLLATE NOCASE, json_each.key
    `,
  );
  return rows.map((row) => row.key);
};
