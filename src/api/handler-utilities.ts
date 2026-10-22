/**
 * Small boundary helpers shared by Effect HTTP handlers.
 */

import { mapApiError } from './error-logging';
import { type toApiError } from './errors';
import { type DomainError, type PersistenceError } from '@/application/errors';
import { requestTelemetry } from '@/telemetry/request';
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';

export const webRequest = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(Effect.orDie);

export const traceRequest = <A, E, R>(
  request: Request,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const telemetry = requestTelemetry(request);
  return telemetry === null
    ? effect
    : (telemetry.provide(effect) as Effect.Effect<A, E, R>);
};

export const runBoundary = <A, E extends DomainError | PersistenceError, R>(
  request: HttpServerRequest.HttpServerRequest,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ReturnType<typeof toApiError>, R> =>
  Effect.gen(function* () {
    const web = yield* webRequest(request);
    return yield* traceRequest(web, mapApiError(web, effect));
  });
