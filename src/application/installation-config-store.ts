/**
 * High-level installation configuration store.
 *
 * The store hides the distributed compare-and-swap mechanism behind two
 * operations: `read` (validated, redacted failures) and `transact` (read,
 * apply a plan, write, and retry lost races with a narrowly filtered
 * `Effect.retry`).
 *
 * Why the raw CAS columns exist: `updated_at` compares the token this
 * operation read, so inter-request writers cannot silently overwrite each
 * other (an Effect `Ref`/`Mutex` only coordinates inside one isolate). The
 * per-write `write_token` gates the audit INSERT inside the same D1 batch on
 * this exact successful mutation, so a losing writer cannot produce an audit
 * entry for another writer's winning token.
 */

import { type DomainError, PersistenceError } from '@/application/errors';
import {
  type Env,
  InstallationConfigDecodeError,
  type InstallationConfigRow,
  readInstallationConfig,
  writeInstallationConfig,
} from '@/db/repository';
import { type AuditWrite, type InstallationConfig } from '@/domain/schemas';
import { Clock, Context, Data, Effect, Layer, Result } from 'effect';

/**
 * One plan for a configuration mutation. Returning a result without a
 * document skips the write (read-only outcomes such as rate limiting).
 */
export type InstallationConfigPlan<A> = (
  current: InstallationConfigRow,
) => Effect.Effect<
  | {
      readonly audit: readonly AuditWrite[];
      readonly document: InstallationConfig;
      readonly result: A;
    }
  | { readonly result: A },
  DomainError
>;

export type InstallationConfigStoreService = {
  /**
   * Reads and validates the document. A corrupt stored row fails with
   * `InstallationConfigUnavailable` and is never modified; database faults
   * stay `PersistenceError`s.
   */
  readonly read: Effect.Effect<
    InstallationConfigRow,
    InstallationConfigUnavailable | PersistenceError
  >;
  /**
   * Reads, applies `plan`, and writes with compare-and-swap. Lost races are
   * retried a bounded number of times; the final failure is
   * `InstallationConfigConflict`.
   */
  readonly transact: <A>(
    actorUserId: null | string,
    plan: InstallationConfigPlan<A>,
  ) => Effect.Effect<
    InstallationConfigTransaction<A>,
    | DomainError
    | InstallationConfigConflict
    | InstallationConfigUnavailable
    | PersistenceError
  >;
};

export type InstallationConfigTransaction<A> = {
  readonly document: InstallationConfig;
  readonly result: A;
};

/**
 * A compare-and-swap race survived every bounded retry.
 */
export class InstallationConfigConflict extends Data.TaggedError(
  'InstallationConfigConflict',
)<{}> {}

export class InstallationConfigStore extends Context.Service<
  InstallationConfigStore,
  InstallationConfigStoreService
>()('InstallationConfigStore') {}

/**
 * The persisted configuration is unreadable/corrupt (redacted).
 */
export class InstallationConfigUnavailable extends Data.TaggedError(
  'InstallationConfigUnavailable',
)<{}> {}

const MAX_CAS_ATTEMPTS = 3;

const readEffect = (
  environment: Env,
): Effect.Effect<
  InstallationConfigRow,
  InstallationConfigUnavailable | PersistenceError
> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof InstallationConfigDecodeError
        ? new InstallationConfigUnavailable()
        : new PersistenceError({ cause }),
    try: () => readInstallationConfig(environment),
  });

export const makeInstallationConfigStore = (
  environment: Env,
): InstallationConfigStoreService => ({
  read: readEffect(environment),
  transact: <A>(actorUserId: null | string, plan: InstallationConfigPlan<A>) =>
    Effect.gen(function* () {
      const attempt = Effect.gen(function* () {
        const current = yield* readEffect(environment);
        const next = yield* plan(current);
        if (!('document' in next)) {
          return { document: current.document, result: next.result };
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const wrote = yield* Effect.tryPromise({
          catch: (cause) => new PersistenceError({ cause }),
          try: () =>
            writeInstallationConfig(environment, {
              actorUserId,
              audit: next.audit,
              document: next.document,
              expectedUpdatedAt: current.updatedAt,
              now: new Date(nowMs),
            }),
        });
        if (!wrote) {
          return yield* Effect.fail(new InstallationConfigConflict());
        }

        return { document: next.document, result: next.result };
      });

      // A lost compare-and-swap is retried immediately: the next attempt
      // re-reads the document, and the bounded loop never depends on a clock
      // sleep, so tests with a controlled clock and production behave alike.
      return yield* Effect.gen(function* () {
        for (let index = 0; index < MAX_CAS_ATTEMPTS; index += 1) {
          const outcome = yield* Effect.result(attempt);
          if (Result.isSuccess(outcome)) {
            return outcome.success;
          }

          if (outcome.failure._tag !== 'InstallationConfigConflict') {
            return yield* Effect.fail(outcome.failure);
          }

          if (index === MAX_CAS_ATTEMPTS - 1) {
            return yield* Effect.fail(outcome.failure);
          }
        }

        return yield* Effect.fail(new InstallationConfigConflict());
      });
    }),
});

export const installationConfigStoreLayer = (
  environment: Env,
): Layer.Layer<InstallationConfigStore> =>
  Layer.succeed(
    InstallationConfigStore,
    makeInstallationConfigStore(environment),
  );
