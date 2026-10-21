import { logRequest } from './logging';
import { type DomainError, type PersistenceError } from '@/application/errors';
import {
  type LeadCreatedPublisher,
  type NotificationRuntime,
  type NotificationServices,
} from '@/notifications/events';
import { requestTelemetry } from '@/telemetry/request';
import { Effect, Result, Schema } from 'effect';

export const errorResponse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response =>
  Response.json(
    { code, details, message },
    {
      status,
    },
  );

/**
 * Domain codes that map to a non-422 status; everything else is 422.
 */
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  // A corrupt installation configuration fails closed and is never echoed or
  // silently reset; the operator restores it out of band.
  config_unavailable: 500,
  conflict: 409,
  not_found: 404,
  revision_conflict: 409,
  scope_conflict: 409,
  scope_exists: 409,
  tag_exists: 409,
  test_daily_limited: 429,
  test_rate_limited: 429,
  test_request_conflict: 409,
};

export const domainErrorStatus = (code: string): number =>
  DOMAIN_ERROR_STATUS[code] ?? 422;

export type RunRequest = <A>(
  request: Request,
  effect: Effect.Effect<
    A,
    DomainError | PersistenceError,
    NotificationServices
  >,
) => Promise<{ data: A } | { error: Response }>;

export const makeRunRequest =
  (runtime: NotificationRuntime): RunRequest =>
  async (request, effect) => {
    try {
      const telemetry = requestTelemetry(request);
      const traced = telemetry === null ? effect : telemetry.provide(effect);
      const outcome = await runtime.runPromise(Effect.result(traced));
      if (Result.isSuccess(outcome)) {
        return { data: outcome.success } as const;
      }

      const error = outcome.failure;
      if (error._tag === 'DomainError') {
        return {
          error: errorResponse(
            domainErrorStatus(error.code),
            error.code,
            error.message,
            error.details,
          ),
        } as const;
      }

      // Structured failure line: the cause's class identifies the layer that
      // failed. The cause's message is deliberately not logged because a
      // database error can embed SQL with bound values (contact data).
      logRequest(request, 500, {
        errorCauseClass:
          error.cause instanceof Error
            ? error.cause.constructor.name
            : typeof error.cause,
        errorClass: 'PersistenceError',
      });
      return {
        error: errorResponse(
          500,
          'persistence_error',
          'The request could not be persisted.',
        ),
      } as const;
    } catch (error) {
      // Command defects are programmer errors; keep the class and message,
      // never the stack.
      logRequest(request, 500, {
        errorClass:
          error instanceof Error
            ? error.name || error.constructor.name
            : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        error: errorResponse(
          500,
          'internal_error',
          'The request could not be completed.',
        ),
      } as const;
    }
  };

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown): Promise<A> =>
  Schema.decodeUnknownPromise(schema)(value);

export const parse = async <A, I>(
  schema: Schema.Codec<A, I>,
  value: unknown,
) => {
  try {
    return { data: await decode(schema, value) } as const;
  } catch (error) {
    return {
      error: errorResponse(422, 'validation_error', 'The request is invalid.', {
        issue: error instanceof Error ? error.message : String(error),
      }),
    } as const;
  }
};

/**
 * Validation for inputs that can carry secrets (provider credentials, test
 * request ids). Decoder failures are never echoed: an Effect message can
 * embed the rejected value. Responses are also no-store so a validation
 * failure is not cached.
 */
export const redactedParse = async <A, I>(
  schema: Schema.Codec<A, I>,
  value: unknown,
) => {
  try {
    return { data: await decode(schema, value) } as const;
  } catch {
    return {
      error: Response.json(
        { code: 'validation_error', message: 'The request is invalid.' },
        { headers: { 'Cache-Control': 'no-store' }, status: 422 },
      ),
    } as const;
  }
};

/**
 * Copies a response with `Cache-Control: no-store` for settings surfaces.
 */
export const withNoStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

// The public intake route is unauthenticated and cookie-free, so it answers
// with `*` and no credentials. Scoped here rather than through
// @elysiajs/cors, whose onRequest hook is global and would add reflected,
// credentialed CORS headers to staff routes as well.
export const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
} as const;

export const withPublicCors = (
  response: Response | undefined,
): Response | undefined => {
  if (response === undefined) {
    return undefined;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

// Installation email administration is open to every enabled authenticated
// staff account. Authentication, disabled-account enforcement, origin, and
// content-type checks still apply; public intake and API tokens are not staff
// sessions and cannot reach these routes.
export const requireRealStaffSession = (
  userId: null | string,
): { error: Response } | { userId: string } => {
  if (userId === null) {
    return {
      error: errorResponse(401, 'unauthorized', 'A real session is required.'),
    };
  }

  return { userId };
};

export type EventsFor = (request: Request) => LeadCreatedPublisher;

export { type NotificationRuntime } from '@/notifications/events';
