import { domainErrorStatus } from './errors';
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
/**
 * Parses a JSON request body for the manually validated routes. A malformed or
 * empty body is a 422, matching the previous framework-level parser contract.
 * Sensitive routes use their own redacted parser instead.
 */
export const readJsonBody = async (
  request: Request,
): Promise<{ data: unknown } | { error: Response }> => {
  const text = await request.text();
  if (text.length === 0) {
    return { data: undefined } as const;
  }

  try {
    return { data: JSON.parse(text) } as const;
  } catch {
    // Malformed JSON is a parse error, distinct from a schema validation
    // failure (422), matching the previous HTTP boundary.
    return {
      error: errorResponse(400, 'validation_error', 'The request is invalid.'),
    } as const;
  }
};

export type RouteContext<P = Record<string, never>> = {
  readonly params: P;
  readonly request: Request;
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
// with `*` and no credentials. Scoped to the intake routes here rather than
// through global middleware, which would add reflected, credentialed CORS
// headers to staff routes as well.
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
