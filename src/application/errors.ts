import { Data, Effect } from 'effect';

export class DomainError extends Data.TaggedError('DomainError')<{
  code: string;
  details?: unknown;
  message: string;
}> {}

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
  cause: unknown;
}> {}

export const domainError = (
  code: string,
  message: string,
  details?: unknown,
): DomainError => new DomainError({ code, details, message });

/**
 * Runs a repository promise, mapping any failure to `PersistenceError`.
 */
export const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });
