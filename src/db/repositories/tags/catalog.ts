import { type Env } from '../../env';
import { tags, tagScopes } from '../../schema';
import { getDatabase } from '../../shared';
import {
  asTagColor,
  type CatalogTagRecord,
  type TagScopeRecord,
  type TagViewRecord,
  toTagViewRecord,
} from './shared';
import { asc, eq, sql } from 'drizzle-orm';

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

export const getTagView = async (
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

export const getScopeView = async (
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
