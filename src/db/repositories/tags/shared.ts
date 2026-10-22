import { leadTags, tags, tagScopes } from '../../schema';
import { type getDatabase } from '../../shared';
import { type TagColor } from '@/domain/schemas';
import { tagLabel } from '@/domain/tags';
import { and, asc, eq, sql } from 'drizzle-orm';

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

export const nextTagColor = (count: number): TagColor =>
  TAG_PALETTE[count % TAG_PALETTE.length] ?? 'teal';

export const asTagColor = (value: null | string): TagColor =>
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

export const toTagViewRecord = (row: TagRowWithScope): TagViewRecord => ({
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
export const tagViewsForLeads = async (
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
