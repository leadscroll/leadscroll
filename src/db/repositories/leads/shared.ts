import { leads } from '../../schema';
import { type TagViewRecord } from '../tags';
import { type Keyset } from '@/domain/pagination';
import { type SkippedField } from '@/domain/schemas';
import { isNull, sql } from 'drizzle-orm';

export type LeadExportPage = {
  nextCursor: null | string;
  rows: LeadExportRow[];
};

export type LeadExportPageOptions = LeadFilterOptions & {
  cursor?: Keyset | null;
  limit: number;
};

/**
 * The minimal lead projection used by the CSV export. Tags, duplicate hints,
 * and diagnostics are deliberately absent: an export row is the lead's own
 * data, not a list-view decoration.
 */
export type LeadExportRow = {
  createdAt: Date;
  customFields: Record<string, unknown>;
  email: null | string;
  estimatedValue: null | number;
  firstName: null | string;
  id: string;
  lastName: null | string;
  origin: null | string;
  source: string;
  updatedAt: Date;
};

export type LeadFilterOptions = {
  query?: string;
  tagId?: string;
  tagScopeId?: string;
};

export type LeadPage = {
  leads: LeadRecord[];
  nextCursor: null | string;
};

export type LeadPageOptions = LeadFilterOptions & {
  cursor?: Keyset | null;
  limit: number;
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
export const leadSearchPredicate = (query: string) => {
  const needle = sql`lower(${query})`;
  return sql`(instr(lower(${leads.email}), ${needle}) > 0 OR instr(lower(${leads.firstName}), ${needle}) > 0 OR instr(lower(${leads.lastName}), ${needle}) > 0)`;
};

/**
 * The shared live-lead filter for the list and the CSV export. Keeping one
 * builder means `query`, `tag`, and `tagScope` can never mean different things
 * in the two read paths.
 */
export const leadFilterPredicates = ({
  query,
  tagId,
  tagScopeId,
}: LeadFilterOptions) => {
  const predicates = [isNull(leads.deletedAt)];
  if (query) {
    predicates.push(leadSearchPredicate(query));
  }

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

  return predicates;
};

/**
 * Keyset position over (created_at DESC, id DESC). The cursor instant is
 * validated by `decodeKeysetCursor` before it reaches this builder.
 */
export const leadKeysetPredicate = (cursor: Keyset) => {
  const cursorTime = Date.parse(cursor.createdAt);
  return sql`(${leads.createdAt} < ${cursorTime} OR (${leads.createdAt} = ${cursorTime} AND ${leads.id} < ${cursor.id}))`;
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
export const duplicateCountExpression = sql<number>`(
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
export const tagsJsonExpression = sql<string>`COALESCE((
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

export const toLead = (
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
