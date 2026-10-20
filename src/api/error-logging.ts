/**
 * Boundary error logging for Effect handlers.
 *
 * Persistence failures keep the existing redacted `request.failure` line:
 * the error class and the cause's class are logged, never the cause message
 * (which can embed SQL with bound values).
 */

import { toApiError } from './errors';
import { logRequest } from './logging';
import { type DomainError, type PersistenceError } from '@/application/errors';
import { Effect } from 'effect';

export const mapApiError = <A, E extends DomainError | PersistenceError, R>(
  request: Request,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ReturnType<typeof toApiError>, R> =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === 'PersistenceError'
        ? Effect.sync(() => {
            logRequest(request, 500, {
              errorCauseClass:
                error.cause instanceof Error
                  ? error.cause.constructor.name
                  : typeof error.cause,
              errorClass: 'PersistenceError',
            });
          })
        : Effect.void,
    ),
    Effect.mapError(toApiError),
  );
