import { DomainError, PersistenceError } from './errors';
import {
  bulkTag,
  createTag,
  deleteTag,
  listTagCatalog,
  setLeadTags,
  type TagMutationOutcome,
  updateTag,
  updateTagScope,
} from '@/db/repository';
import {
  deriveTagSpecs,
  parseTagName,
  TAG_PREFIX_MAX,
  type TagSpec,
} from '@/domain/tags';
import { Effect } from 'effect';

const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });

const parsedSpec = (name: string): TagSpec => {
  const parsed = parseTagName(name);
  if ('error' in parsed) {
    throw new DomainError({ code: 'invalid_tag', message: parsed.error });
  }

  return { name: parsed.name, prefix: parsed.prefix };
};

const parsedScopePrefix = (prefix: string): string => {
  const normalized = prefix.trim().toLowerCase();
  if (
    normalized === '' ||
    normalized.includes(':') ||
    normalized.length > TAG_PREFIX_MAX
  ) {
    throw new DomainError({
      code: 'invalid_scope',
      message: `Enter a scope of 1-${String(TAG_PREFIX_MAX)} characters without a colon.`,
    });
  }

  return normalized;
};

const mutationError = (outcome: TagMutationOutcome): DomainError => {
  if (outcome.kind === 'conflict') {
    return new DomainError({ code: outcome.code, message: outcome.message });
  }

  return new DomainError({ code: 'not_found', message: 'Tag not found.' });
};

const expectOk = (
  outcome: TagMutationOutcome,
): Effect.Effect<Extract<TagMutationOutcome, { kind: 'ok' }>, DomainError> =>
  outcome.kind === 'ok'
    ? Effect.succeed(outcome)
    : Effect.fail(mutationError(outcome));

export const listTagsCommand = (
  environment: Parameters<typeof listTagCatalog>[0],
) => persist(() => listTagCatalog(environment));

export const createTagCommand = (
  environment: Parameters<typeof createTag>[0],
  name: string,
) =>
  Effect.gen(function* () {
    const spec = yield* Effect.try({
      catch: (cause) =>
        cause instanceof DomainError
          ? cause
          : new DomainError({ code: 'invalid_tag', message: 'Invalid tag.' }),
      try: () => parsedSpec(name),
    });
    const outcome = yield* persist(() => createTag(environment, spec));
    return yield* expectOk(outcome);
  });

export const updateTagCommand = (
  environment: Parameters<typeof updateTag>[0],
  tagId: string,
  patch: { color?: Parameters<typeof updateTag>[2]['color']; name?: string },
) =>
  Effect.gen(function* () {
    const spec = yield* Effect.try({
      catch: (cause) =>
        cause instanceof DomainError
          ? cause
          : new DomainError({ code: 'invalid_tag', message: 'Invalid tag.' }),
      try: () =>
        patch.name === undefined ? undefined : parsedSpec(patch.name),
    });
    const outcome = yield* persist(() =>
      updateTag(environment, tagId, {
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(spec === undefined ? {} : { name: spec }),
      }),
    );
    return yield* expectOk(outcome);
  });

export const updateTagScopeCommand = (
  environment: Parameters<typeof updateTagScope>[0],
  scopeId: string,
  patch: {
    color?: Parameters<typeof updateTagScope>[2]['color'];
    prefix?: string;
  },
) =>
  Effect.gen(function* () {
    const prefix = yield* Effect.try({
      catch: (cause) =>
        cause instanceof DomainError
          ? cause
          : new DomainError({
              code: 'invalid_scope',
              message: 'Invalid scope.',
            }),
      try: () =>
        patch.prefix === undefined
          ? undefined
          : parsedScopePrefix(patch.prefix),
    });
    const outcome = yield* persist(() =>
      updateTagScope(environment, scopeId, {
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(prefix === undefined ? {} : { prefix }),
      }),
    );
    if (outcome.kind === 'not-found') {
      return yield* Effect.fail(
        new DomainError({ code: 'not_found', message: 'Scope not found.' }),
      );
    }

    if (outcome.kind === 'conflict') {
      return yield* Effect.fail(
        new DomainError({ code: outcome.code, message: outcome.message }),
      );
    }

    return outcome;
  });

export const deleteTagCommand = (
  environment: Parameters<typeof deleteTag>[0],
  tagId: string,
) =>
  Effect.gen(function* () {
    const outcome = yield* persist(() => deleteTag(environment, tagId));
    if (outcome.kind === 'not-found') {
      return yield* Effect.fail(
        new DomainError({ code: 'not_found', message: 'Tag not found.' }),
      );
    }

    return outcome;
  });

export const setLeadTagsCommand = (
  environment: Parameters<typeof setLeadTags>[0],
  leadId: string,
  tagIds: readonly string[],
) =>
  Effect.gen(function* () {
    const outcome = yield* persist(() =>
      setLeadTags(environment, leadId, tagIds),
    );
    if (outcome.kind === 'not-found') {
      return yield* Effect.fail(
        new DomainError({ code: 'not_found', message: 'Lead not found.' }),
      );
    }

    if (outcome.kind === 'unknown-tag') {
      return yield* Effect.fail(
        new DomainError({
          code: 'unknown_tag',
          details: { tagIds: outcome.tagIds },
          message: 'One or more selected tags no longer exist.',
        }),
      );
    }

    return outcome;
  });

export const bulkTagCommand = (
  environment: Parameters<typeof bulkTag>[0],
  leadIds: readonly string[],
  tagIds: readonly string[],
  mode: 'add' | 'remove',
) =>
  Effect.gen(function* () {
    const outcome = yield* persist(() =>
      bulkTag(environment, leadIds, tagIds, mode),
    );
    if (outcome.kind === 'unknown-lead') {
      return yield* Effect.fail(
        new DomainError({
          code: 'unknown_lead',
          details: { leadIds: outcome.leadIds },
          message: 'One or more selected leads no longer exist.',
        }),
      );
    }

    if (outcome.kind === 'unknown-tag') {
      return yield* Effect.fail(
        new DomainError({
          code: 'unknown_tag',
          details: { tagIds: outcome.tagIds },
          message: 'One or more selected tags no longer exist.',
        }),
      );
    }

    return outcome;
  });

/**
 * Resolves the tag specs for an atomic lead write. Parses the explicit
 * `tags` list and, when no explicit `source:*` tag is present, appends the
 * lossless `source:<value>` classification. A malformed explicit tag name
 * fails validation instead of being silently dropped. This runs after the
 * intake fingerprint is computed and never mutates the decoded input, so an
 * existing request's fingerprint is unchanged.
 */
export const leadTagSpecs = (input: {
  source?: null | string;
  tags?: readonly string[];
}): Effect.Effect<TagSpec[], DomainError> =>
  Effect.try({
    catch: (cause) =>
      cause instanceof DomainError
        ? cause
        : new DomainError({ code: 'invalid_tag', message: 'Invalid tag.' }),
    try: () => {
      const derived = deriveTagSpecs(input);
      if ('error' in derived) {
        throw new DomainError({
          code: 'invalid_tag',
          message: derived.error,
        });
      }

      return derived.specs;
    },
  });
