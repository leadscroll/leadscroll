import { type Env } from '../../env';
import { leads, leadTags, tags, tagScopes } from '../../schema';
import {
  executeAtomically,
  getDatabase,
  id,
  isUniqueViolation,
  now,
  prepare,
  type Statement,
  uniqueConstraintTarget,
} from '../../shared';
import { getScopeView, getTagView } from './catalog';
import {
  asTagColor,
  nextTagColor,
  type TagScopeRecord,
  type TagViewRecord,
} from './shared';
import { type TagColor } from '@/domain/schemas';
import { type TagSpec } from '@/domain/tags';
import { and, eq, isNull, sql } from 'drizzle-orm';

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
