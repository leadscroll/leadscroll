import { logRequest } from './logging';
import { requestWaitUntil } from '@/api/execution-context';
import { mapIntakeBodyError, parseIntakeBody } from '@/api/intake-parser';
import {
  listAccountSessionsCommand,
  revokeAccountSessionCommand,
  revokeOtherAccountSessionsCommand,
} from '@/application/account-commands';
import {
  createIntakeCommand,
  createLeadActivityCommand,
  createLeadCommand,
  softDeleteLeadsCommand,
  updateLeadCommand,
} from '@/application/commands';
import { type DomainError, type PersistenceError } from '@/application/errors';
import {
  getEmailSettingsViewCommand,
  getNotificationPreferenceView,
  sendTestEmailCommand,
  updateEmailSettingsCommand,
  updateNotificationPreferenceCommand,
} from '@/application/notification-commands';
import {
  bulkTagCommand,
  createTagCommand,
  deleteTagCommand,
  listTagsCommand,
  setLeadTagsCommand,
  updateTagCommand,
  updateTagScopeCommand,
} from '@/application/tag-commands';
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
  createAuth,
  matchesBootstrapToken,
  resolveAuthOrigin,
} from '@/auth';
import {
  bearerToken,
  requireSessionIdentity,
  UnauthorizedError,
} from '@/auth/access';
import { createAccountAuthEndpoints } from '@/auth/account-management';
import { handleInvitationSignUp } from '@/auth/invitation-sign-up';
import {
  blockedRetryAfter,
  rateLimitedResponse,
  rememberBlocked,
} from '@/auth/rate-limit-cache';
import { handleDisabledAccountSignIn } from '@/auth/sign-in-guard';
import {
  checkStaffInviteAvailability,
  createApiToken,
  createStaffInvite,
  type Env,
  getLead,
  isBootstrapGrantAvailable,
  isBrowserIntakeToken,
  isIntakeToken,
  listApiTokens,
  listLeadActivities,
  listLeads,
  listStaffAccounts,
  listStaffInvites,
  revokeApiToken,
  revokeStaffInvite,
  setStaffAccountDisabled,
} from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import { decodeKeysetCursor, LIST_LIMIT_DEFAULT } from '@/domain/pagination';
import {
  BulkDeleteLeadsRequestSchema,
  BulkTagRequestSchema,
  CreateInviteRequestSchema,
  CreateLeadActivityRequestSchema,
  CreateLeadRequestSchema,
  CreateTagRequestSchema,
  CreateTokenRequestSchema,
  HealthSchema,
  IntakeRequestSchema,
  ListLeadsQuerySchema,
  SendEmailTestRequestSchema,
  SetLeadTagsRequestSchema,
  SetStaffDisabledRequestSchema,
  UpdateEmailSettingsRequestSchema,
  UpdateLeadRequestSchema,
  UpdateNotificationPreferenceRequestSchema,
  UpdateTagRequestSchema,
  UpdateTagScopeRequestSchema,
  ValidateInviteRequestSchema,
} from '@/domain/schemas';
import {
  createLeadCreatedPublisher,
  type LeadCreatedPublisher,
  type LeadCreatedSubscriber,
} from '@/notifications/events';
import { createLeadCreatedEmailSubscriber } from '@/notifications/lead-created-subscriber';
import { Effect, Either, Schema } from 'effect';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';

const errorResponse = (
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
 * Browser CSRF defence: a request that carries an Origin header must match the
 * configured auth origin. A missing Origin is allowed for non-browser clients,
 * consistent with the auth routes. Forwarded headers are never consulted.
 */
const rejectUntrustedOrigin = (
  environment: Env,
  request: Request,
): null | Response => {
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return null;
  }

  let trusted: string;
  try {
    trusted = resolveAuthOrigin(environment, request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return authenticationNotConfiguredResponse();
    }

    throw error;
  }

  return origin === trusted
    ? null
    : errorResponse(403, 'forbidden', 'The request origin is not trusted.');
};

const UNSAFE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

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

const domainErrorStatus = (code: string): number =>
  DOMAIN_ERROR_STATUS[code] ?? 422;

/**
 * Cookie-authenticated staff routes set no CORS headers, so a hostile page
 * cannot read their responses; but a same-site sibling origin can still post an
 * ordinary HTML form and have the browser attach the session cookie under
 * SameSite=Lax. Unsafe methods therefore require a trusted Origin when one is
 * present, and any supplied body must be JSON — Elysia would otherwise parse
 * form-encoded posts on these routes.
 */
const rejectUntrustedStaffWrite = (
  environment: Env,
  request: Request,
): null | Response => {
  if (!UNSAFE_METHODS.has(request.method)) {
    return null;
  }

  const rejectedOrigin = rejectUntrustedOrigin(environment, request);
  if (rejectedOrigin !== null) {
    return rejectedOrigin;
  }

  const contentType = request.headers.get('content-type');
  if (contentType !== null) {
    // The media type is everything before any parameters (`; charset=...`).
    // Only exact `application/json` is accepted: a prefix check would let
    // `application/jsonp` and similar types through.
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return errorResponse(
        415,
        'unsupported_media_type',
        'Staff requests with a body must use application/json.',
      );
    }
  }

  return null;
};

const run = async <A>(
  request: Request,
  effect: Effect.Effect<A, DomainError | PersistenceError>,
): Promise<{ data: A } | { error: Response }> => {
  try {
    const outcome = await Effect.runPromise(Effect.either(effect));
    if (Either.isRight(outcome)) {
      return { data: outcome.right } as const;
    }

    const error = outcome.left;
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

const decode = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): Promise<A> => Schema.decodeUnknownPromise(schema)(value);

const parse = async <A, I>(
  schema: Schema.Schema<A, I, never>,
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
const redactedParse = async <A, I>(
  schema: Schema.Schema<A, I, never>,
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
const withNoStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

type AuthForRequest = (request: Request) => Auth;

const requireAdmin = async (
  request: Request,
  getAuth: AuthForRequest,
  environment: Env,
) => {
  try {
    return {
      identity: await requireSessionIdentity(
        request,
        getAuth(request),
        environment,
      ),
    } as const;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return { error: authenticationNotConfiguredResponse() } as const;
    }

    if (error instanceof UnauthorizedError) {
      return {
        error: errorResponse(401, 'unauthorized', error.message),
      } as const;
    }

    // The identity lookup itself failed (for example a D1 fault while
    // reading the session or staff row): this is an authentication backend
    // failure, not a lost login. Report a generic 500 so the client can
    // retry, and log the cause's class so it can be told
    // apart from a true 401 in the logs. The exception message is never
    // logged or returned because it can embed SQL with bound values.
    logRequest(request, 500, {
      errorCauseClass:
        error instanceof Error ? error.constructor.name : typeof error,
      errorClass: 'AuthenticationUnavailable',
    });
    return {
      error: errorResponse(
        500,
        'authentication_unavailable',
        'Authentication could not be checked. Please try again.',
      ),
    } as const;
  }
};

// Installation email administration is open to every enabled authenticated
// staff account. Authentication, disabled-account enforcement, origin, and
// content-type checks still apply; public intake and API tokens are not staff
// sessions and cannot reach these routes.
const requireRealStaffSession = (
  userId: null | string,
): { error: Response } | { userId: string } => {
  if (userId === null) {
    return {
      error: errorResponse(401, 'unauthorized', 'A real session is required.'),
    };
  }

  return { userId };
};

// The public intake route is unauthenticated and cookie-free, so it answers
// with `*` and no credentials. Scoped here rather than through
// @elysiajs/cors, whose onRequest hook is global and would add reflected,
// credentialed CORS headers to staff routes as well.
const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
} as const;

const withPublicCors = (
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

const createAppWithAuth = (
  environment: Env,
  getAuth: AuthForRequest,
  options: CreateAppOptions = {},
) => {
  // Subscribers are registered once at composition time; every request builds
  // only a small scoped publisher around the runtime execution context.
  const subscribers: readonly LeadCreatedSubscriber[] =
    options.notificationSubscribers ?? [createLeadCreatedEmailSubscriber()];
  const eventsFor = (request: Request): LeadCreatedPublisher =>
    createLeadCreatedPublisher({
      environment,
      subscribers,
      waitUntil: (promise) => {
        const waitUntil = requestWaitUntil(request);
        if (waitUntil === null) {
          // Never silently drop the event: the publisher catches this and
          // logs a scheduling_failed line while the lead stays committed.
          throw new Error(
            'No Worker execution context is registered for this request.',
          );
        }

        waitUntil(promise);
      },
    });

  const accountEndpoints = createAccountAuthEndpoints(getAuth, environment);
  const publicIntake = new Elysia({ name: 'public-intake' })
    .options(
      '/v1/public/intakes/:token',
      () => new Response(null, { headers: PUBLIC_CORS_HEADERS, status: 204 }),
    )
    .post(
      '/v1/public/intakes/:token',
      async ({ body, params, request }) => {
        const tokenRecord = await isBrowserIntakeToken(
          environment,
          params.token,
        );
        if (!tokenRecord) {
          return withPublicCors(
            errorResponse(
              401,
              'invalid_token',
              'A valid browser intake token is required.',
            ),
          );
        }

        const clientKey =
          request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
        if (!isIntakeKey(clientKey)) {
          return withPublicCors(
            errorResponse(
              400,
              'invalid_idempotency_key',
              'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            ),
          );
        }

        // Browser keys are namespaced per token so they can never collide with
        // keys an API integration chose for `/v1/intakes`.
        const idempotencyKey = `browser:${tokenRecord.id}:${clientKey}`;

        const parsed = await parse(IntakeRequestSchema, body);
        if ('error' in parsed) {
          return withPublicCors(parsed.error);
        }

        const result = await run(
          request,
          createIntakeCommand(
            environment,
            parsed.data,
            idempotencyKey,
            {
              origin: request.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body,
            eventsFor(request),
          ),
        );
        if ('error' in result) {
          return withPublicCors(result.error);
        }

        switch (result.data.kind) {
          case 'conflict':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_conflict',
                'This submission was already accepted with a different payload.',
              ),
            );
          case 'created':
          case 'replayed':
            // The public surface stays minimal: no lead id is returned.
            return withPublicCors(
              Response.json({ data: { created: true } }, { status: 201 }),
            );
          case 'legacy_unverifiable':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_legacy_unverifiable',
                'This submission cannot be verified. Please use a new submission key.',
              ),
            );
        }

        return withPublicCors(
          errorResponse(
            500,
            'internal_error',
            'The intake request could not be completed.',
          ),
        );
      },
      {
        error: ({ error }) =>
          mapIntakeBodyError(error, (code, response) =>
            withPublicCors(Response.json(response, { status: code })),
          ),
        parse: parseIntakeBody,
      },
    );

  return (
    new Elysia({
      adapter: CloudflareAdapter,
      name: 'leadscroll-api',
    })
      // Elysia's mount() strips the mount prefix before forwarding. Better Auth
      // expects its full basePath, so re-add the prefix to the cloned request.
      // POST /sign-up/email is the invitation boundary: it resolves the grant
      // before any account write and re-issues the session through Better
      // Auth's sign-in endpoint.
      .mount('/api/auth', async (mountedRequest: Request) => {
        try {
          const url = new URL(mountedRequest.url);
          const accountPath = url.pathname.replace(/\/+$/u, '');
          // Normalize only account endpoints so their field/revocation boundary
          // covers trailing slashes. Preserve existing sign-up alias rejection.
          const path =
            accountPath === '/update-user' || accountPath === '/change-password'
              ? accountPath
              : url.pathname;
          url.pathname = path;
          const request = new Request(url, mountedRequest);

          // A client already over a limit skips Better Auth (and the database
          // limiter's read/update) until its retry window passes. The database
          // counter stays authoritative; this only short-circuits known blocks.
          const retryAfter = await blockedRetryAfter(request, path);
          if (retryAfter !== null) {
            return rateLimitedResponse(retryAfter);
          }

          const dispatch = async (): Promise<Response> => {
            if (request.method === 'POST' && path === '/sign-up/email') {
              return handleInvitationSignUp(environment, request, getAuth);
            }

            if (request.method === 'POST' && path === '/sign-in/email') {
              return handleDisabledAccountSignIn(environment, request, getAuth);
            }

            // Self-service account management: the interceptors validate and
            // re-attach the body before Better Auth runs.
            if (request.method === 'POST' && path === '/change-password') {
              const raw = await request.text();
              return accountEndpoints.changePassword(request, raw);
            }

            if (request.method === 'POST' && path === '/update-user') {
              const raw = await request.text();
              return accountEndpoints.updateUser(request, raw);
            }

            url.pathname = `/api/auth${path}`;
            return getAuth(request).handler(new Request(url, request));
          };

          const response = await dispatch();
          if (response.status === 429) {
            await rememberBlocked(
              request,
              path,
              Number(response.headers.get('x-retry-after') ?? ''),
            );
          }

          return response;
        } catch (error) {
          if (error instanceof AuthConfigurationError) {
            return authenticationNotConfiguredResponse();
          }

          throw error;
        }
      })
      .get('/health', () => ({ ok: true }), {
        response: { '200': Schema.standardSchemaV1(HealthSchema) },
      })
      // Contract spike: Elysia's Standard Schema path yields `code: 'VALIDATION'`
      // errors. Normalize them to the same `{ code, details, message }` envelope
      // the manual `parse()` helper returns, so clients see one error shape.
      // Decoder messages are never returned: some schemas accept free-form
      // values (custom fields, notes) that a message could echo. Malformed
      // JSON is redacted only on the sensitive settings route; intake has its
      // own route-level parser mapping (413/415).
      .onError(({ code, error, request }) => {
        if (error instanceof Response) {
          return error;
        }

        if (code === 'VALIDATION') {
          return withNoStore(
            errorResponse(422, 'validation_error', 'The request is invalid.'),
          );
        }

        if (
          code === 'PARSE' &&
          new URL(request.url).pathname.startsWith('/v1/settings/email')
        ) {
          return withNoStore(
            errorResponse(422, 'validation_error', 'The request is invalid.'),
          );
        }

        return undefined;
      })
      .post(
        '/v1/intakes',
        async ({ body, request }) => {
          const token = bearerToken(request);
          const tokenRecord = token
            ? await isIntakeToken(environment, token)
            : null;
          if (!tokenRecord) {
            return errorResponse(
              401,
              'unauthorized',
              'A valid intake token is required.',
            );
          }

          const idempotencyKey = request.headers.get('Idempotency-Key');
          if (!idempotencyKey) {
            return errorResponse(
              400,
              'idempotency_key_required',
              'Idempotency-Key is required.',
            );
          }

          if (!isIntakeKey(idempotencyKey)) {
            return errorResponse(
              400,
              'invalid_idempotency_key',
              'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            );
          }

          const parsed = await parse(IntakeRequestSchema, body);
          if ('error' in parsed) {
            return parsed.error;
          }

          const result = await run(
            request,
            createIntakeCommand(
              environment,
              parsed.data,
              idempotencyKey,
              {
                origin: request.headers.get('Origin'),
                tokenId: tokenRecord.id,
              },
              body,
              eventsFor(request),
            ),
          );
          if ('error' in result) {
            return result.error;
          }

          switch (result.data.kind) {
            case 'conflict':
              return errorResponse(
                409,
                'idempotency_conflict',
                'This Idempotency-Key has already been used with a different payload. Reconcile the stored response before resubmitting.',
              );
            case 'created':
            case 'replayed':
              // Replays keep the original HTTP 201 and stored response for
              // compatibility, without touching leads or history.
              return Response.json(
                { data: result.data.response },
                { status: 201 },
              );
            case 'legacy_unverifiable': {
              const stored = result.data.storedResponse;
              return errorResponse(
                409,
                'idempotency_legacy_unverifiable',
                'This Idempotency-Key was accepted before request fingerprints existed and cannot be verified. Reconcile it against the already stored lead before submitting again.',
                typeof stored.leadId === 'string'
                  ? { leadId: stored.leadId }
                  : undefined,
              );
            }
          }

          // Every kind above returns; this guard only fires if a new outcome
          // kind is added without a handler
          return errorResponse(
            500,
            'internal_error',
            'The intake request could not be completed.',
          );
        },
        {
          error: ({ error, status }) => mapIntakeBodyError(error, status),
          // The raw intake body is bounded to 65,536 actual bytes by the
          // get-stream-backed parse hook BEFORE JSON decoding and domain
          // writes, on every accepted alias of this route. Overflow is mapped
          // to the existing 413 payload_too_large response by the error hook.
          parse: parseIntakeBody,
        },
      )
      .use(publicIntake)
      .post('/api/invites/validate', async ({ body, request }) => {
        const rejectedOrigin = rejectUntrustedOrigin(environment, request);
        if (rejectedOrigin !== null) {
          return rejectedOrigin;
        }

        const parsed = await parse(ValidateInviteRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        // Non-consuming: a valid grant is reported without touching
        // used_at or any other column.
        const valid = matchesBootstrapToken(environment, parsed.data.token)
          ? await isBootstrapGrantAvailable(environment)
          : await checkStaffInviteAvailability(environment, parsed.data.token);
        return valid
          ? { valid: true }
          : errorResponse(
              403,
              'invite_unavailable',
              'Invitation is unavailable.',
            );
      })

      // Staff routes: one shared auth gate. Elysia applies lifecycle hooks to
      // routes registered after them, so every route below requires a staff
      // session; handlers read `adminEmail` from context instead of repeating
      // the guard. The gate also rejects untrusted write origins and non-JSON
      // write bodies before a handler can mutate state. Non-staff routes (auth
      // mount, health, intakes, invite validation) are registered above this
      // hook.
      .resolve(async ({ request }) => {
        const admin = await requireAdmin(request, getAuth, environment);
        if ('error' in admin) {
          throw admin.error;
        }

        const rejectedWrite = rejectUntrustedStaffWrite(environment, request);
        if (rejectedWrite !== null) {
          throw rejectedWrite;
        }

        return {
          adminEmail: admin.identity.email,
          // The account-sessions routes need the caller's own session row;
          // no raw token is propagated into application context.
          adminSession: admin.identity.session,
          // Durable account id, used for self-suppression and per-user
          // notification state. Null for the development bypass when no
          // matching account row exists; such routes fail closed.
          adminUserId: admin.identity.userId,
        };
      })
      .get(
        '/v1/leads',
        async ({ query }) => {
          let cursor = null;
          if (query.cursor !== undefined) {
            cursor = decodeKeysetCursor(query.cursor);
            if (cursor === null) {
              return errorResponse(
                422,
                'invalid_cursor',
                'cursor is invalid. Use the nextCursor value from a previous response.',
              );
            }
          }

          const page = await listLeads(environment, {
            cursor,
            limit: query.limit ?? LIST_LIMIT_DEFAULT,
            query: query.query,
            tagId: query.tag,
            tagScopeId: query.tagScope,
          });
          return { data: page.leads, nextCursor: page.nextCursor };
        },
        { query: Schema.standardSchemaV1(ListLeadsQuerySchema) },
      )
      .post(
        '/v1/leads',
        async ({ adminUserId, body, request }) => {
          const result = await run(
            request,
            createLeadCommand(
              environment,
              body,
              adminUserId,
              eventsFor(request),
            ),
          );
          return 'error' in result
            ? result.error
            : Response.json({ data: result.data }, { status: 201 });
        },
        { body: Schema.standardSchemaV1(CreateLeadRequestSchema) },
      )
      .post(
        '/v1/leads/bulk-delete',
        async ({ body, request }) => {
          const result = await run(
            request,
            softDeleteLeadsCommand(environment, body.ids),
          );
          return 'error' in result
            ? result.error
            : { data: { deleted: result.data } };
        },
        { body: Schema.standardSchemaV1(BulkDeleteLeadsRequestSchema) },
      )
      .patch(
        '/v1/leads/:id',
        async ({ body, params, request }) => {
          const result = await run(
            request,
            updateLeadCommand(environment, params.id, body),
          );
          if ('error' in result) {
            return result.error;
          }

          return result.data
            ? { data: result.data }
            : errorResponse(404, 'not_found', 'Lead not found.');
        },
        { body: Schema.standardSchemaV1(UpdateLeadRequestSchema) },
      )
      .get('/v1/leads/:id/activities', async ({ params }) => {
        return { data: await listLeadActivities(environment, params.id) };
      })
      .post(
        '/v1/leads/:id/activities',
        async ({ adminEmail, body, params, request }) => {
          const result = await run(
            request,
            createLeadActivityCommand(
              environment,
              params.id,
              adminEmail,
              body.kind ?? 'note',
              body.body,
            ),
          );
          if ('error' in result) {
            return result.error;
          }

          return result.data
            ? Response.json({ data: result.data }, { status: 201 })
            : errorResponse(404, 'not_found', 'Lead not found.');
        },
        { body: Schema.standardSchemaV1(CreateLeadActivityRequestSchema) },
      )
      .get('/v1/leads/:id', async ({ params }) => {
        const lead = await getLead(environment, params.id);
        return lead
          ? { data: lead }
          : errorResponse(404, 'not_found', 'Lead not found.');
      })
      // Tag catalog. Scopes are inferred from `prefix:value` names; the API is
      // the exclusivity boundary and the database constraint is the backstop.
      .get('/v1/tags', async ({ request }) => {
        const result = await run(request, listTagsCommand(environment));
        return 'error' in result ? result.error : { data: result.data };
      })
      .post('/v1/tags', async ({ body, request }) => {
        const parsed = await parse(CreateTagRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          createTagCommand(environment, parsed.data.name),
        );
        if ('error' in result) {
          return result.error;
        }

        return Response.json({ data: result.data.tag }, { status: 201 });
      })
      .patch('/v1/tag-scopes/:id', async ({ body, params, request }) => {
        const parsed = await parse(UpdateTagScopeRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          updateTagScopeCommand(environment, params.id, parsed.data),
        );
        return 'error' in result ? result.error : { data: result.data.scope };
      })
      .patch('/v1/tags/:id', async ({ body, params, request }) => {
        const parsed = await parse(UpdateTagRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          updateTagCommand(environment, params.id, parsed.data),
        );
        return 'error' in result ? result.error : { data: result.data.tag };
      })
      .delete('/v1/tags/:id', async ({ params, request }) => {
        const result = await run(
          request,
          deleteTagCommand(environment, params.id),
        );
        return 'error' in result
          ? result.error
          : { data: { removed: result.data.removed } };
      })
      .put('/v1/leads/:id/tags', async ({ body, params, request }) => {
        const parsed = await parse(SetLeadTagsRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          setLeadTagsCommand(environment, params.id, parsed.data.tagIds),
        );
        return 'error' in result ? result.error : { data: result.data.tags };
      })
      .post('/v1/leads/tags/bulk', async ({ body, request }) => {
        const parsed = await parse(BulkTagRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          bulkTagCommand(
            environment,
            parsed.data.ids,
            parsed.data.tagIds,
            parsed.data.mode,
          ),
        );
        return 'error' in result
          ? result.error
          : { data: { affected: result.data.affected } };
      })
      .get('/v1/tokens', async () => {
        return { data: await listApiTokens(environment) };
      })
      .post('/v1/tokens', async ({ body }) => {
        const parsed = await parse(CreateTokenRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        return Response.json(
          {
            data: await createApiToken(environment, {
              expiresAt: parsed.data.expiresAt,
              name: parsed.data.name,
              type: parsed.data.type ?? 'api',
            }),
          },
          { status: 201 },
        );
      })
      .delete('/v1/tokens/:id', async ({ params }) => {
        return (await revokeApiToken(environment, params.id))
          ? new Response(null, { status: 204 })
          : errorResponse(404, 'not_found', 'Token not found.');
      })
      .get('/v1/invites', async () => {
        return { data: await listStaffInvites(environment) };
      })
      .post('/v1/invites', async ({ body }) => {
        const parsed = await parse(CreateInviteRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const invite = await createStaffInvite(
          environment,
          parsed.data.name,
          parsed.data.expiresAt,
        );
        return Response.json(
          {
            data: {
              createdAt: invite.createdAt,
              expiresAt: invite.expiresAt,
              id: invite.id,
              name: invite.name,
              prefix: invite.prefix,
              // The raw token is returned exactly once, at creation.
              token: invite.token,
            },
          },
          { status: 201 },
        );
      })
      .delete('/v1/invites/:id', async ({ params }) => {
        return (await revokeStaffInvite(environment, params.id))
          ? new Response(null, { status: 204 })
          : errorResponse(404, 'not_found', 'Invitation not found.');
      })
      .get('/v1/staff', async () => {
        return { data: await listStaffAccounts(environment) };
      })
      .patch('/v1/staff/:id', async ({ adminEmail, body, params }) => {
        const parsed = await parse(SetStaffDisabledRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const outcome = await setStaffAccountDisabled(
          environment,
          params.id,
          parsed.data.disabled,
          adminEmail,
        );
        if (outcome.kind === 'not-found') {
          return errorResponse(404, 'not_found', 'Staff account not found.');
        }

        if (outcome.kind === 'self') {
          return errorResponse(
            409,
            'conflict',
            'An account cannot disable itself.',
          );
        }

        if (outcome.kind === 'last-enabled') {
          return errorResponse(
            409,
            'conflict',
            'The last enabled staff account cannot be disabled.',
          );
        }

        return { data: outcome.record };
      })
      // Self-service session management. The list never includes token
      // material; the current session is flagged so the UI can distinguish
      // "this device" from revocable rows.
      .get('/v1/account/sessions', async ({ adminSession, request }) => {
        if (!adminSession) {
          return errorResponse(
            401,
            'unauthorized',
            'A real session is required.',
          );
        }

        const result = await run(
          request,
          listAccountSessionsCommand(environment, adminSession),
        );
        return 'error' in result ? result.error : { data: result.data };
      })
      .delete(
        '/v1/account/sessions/:id',
        async ({ adminSession, params, request }) => {
          if (!adminSession) {
            return errorResponse(
              401,
              'unauthorized',
              'A real session is required.',
            );
          }

          const result = await run(
            request,
            revokeAccountSessionCommand(environment, adminSession, params.id),
          );
          if ('error' in result) {
            return result.error;
          }

          if (result.data === 'current') {
            return errorResponse(
              409,
              'conflict',
              'The current session cannot revoke itself; use sign out instead.',
            );
          }

          return result.data === 'revoked'
            ? new Response(null, { status: 204 })
            : errorResponse(404, 'not_found', 'Session not found.');
        },
      )
      .post(
        '/v1/account/sessions/revoke-others',
        async ({ adminSession, request }) => {
          if (!adminSession) {
            return errorResponse(
              401,
              'unauthorized',
              'A real session is required.',
            );
          }

          const result = await run(
            request,
            revokeOtherAccountSessionsCommand(environment, adminSession),
          );
          return 'error' in result
            ? result.error
            : { data: { revoked: result.data } };
        },
      )
      // Self-service notification preference. The session user id is
      // authoritative; no path or body field can address another staff
      // member's row.
      .get('/v1/account/notifications', async ({ adminUserId }) => {
        if (adminUserId === null) {
          return errorResponse(
            401,
            'unauthorized',
            'A real session is required.',
          );
        }

        return {
          data: await getNotificationPreferenceView(environment, adminUserId),
        };
      })
      .put(
        '/v1/account/notifications',
        async ({ adminUserId, body, request }) => {
          if (adminUserId === null) {
            return errorResponse(
              401,
              'unauthorized',
              'A real session is required.',
            );
          }

          const parsed = await parse(
            UpdateNotificationPreferenceRequestSchema,
            body,
          );
          if ('error' in parsed) {
            return parsed.error;
          }

          const result = await run(
            request,
            updateNotificationPreferenceCommand(
              environment,
              adminUserId,
              parsed.data.newLeadEmail,
            ),
          );
          return 'error' in result ? result.error : { data: result.data };
        },
      )
      // Installation email settings. The shared staff session guard above
      // already enforces authentication, disabled accounts, trusted writes,
      // and JSON bodies; every enabled staff account may manage the
      // installation's email configuration.
      .get('/v1/settings/email', async ({ adminUserId, request }) => {
        const admin = requireRealStaffSession(adminUserId);
        if ('error' in admin) {
          return withNoStore(admin.error);
        }

        const result = await run(
          request,
          getEmailSettingsViewCommand(
            environment,
            resolveAuthOrigin(environment, request),
          ),
        );
        if ('error' in result) {
          return withNoStore(result.error);
        }

        return Response.json(
          { data: result.data },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      })
      .put('/v1/settings/email', async ({ adminUserId, body, request }) => {
        const admin = requireRealStaffSession(adminUserId);
        if ('error' in admin) {
          return withNoStore(admin.error);
        }

        const parsed = await redactedParse(
          UpdateEmailSettingsRequestSchema,
          body,
        );
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          updateEmailSettingsCommand(environment, {
            actorUserId: admin.userId,
            canonicalOrigin: resolveAuthOrigin(environment, request),
            credential: parsed.data.credential,
            enabled: parsed.data.enabled,
            expectedRevision: parsed.data.expectedRevision,
            fromEmail: parsed.data.fromEmail ?? null,
            fromName: parsed.data.fromName ?? null,
            provider: parsed.data.provider,
          }),
        );
        if ('error' in result) {
          return withNoStore(result.error);
        }

        return Response.json(
          { data: result.data },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      })
      .post(
        '/v1/settings/email/test',
        async ({ adminEmail, adminUserId, body, request }) => {
          const admin = requireRealStaffSession(adminUserId);
          if ('error' in admin) {
            return withNoStore(admin.error);
          }

          const parsed = await redactedParse(SendEmailTestRequestSchema, body);
          if ('error' in parsed) {
            return parsed.error;
          }

          const result = await run(
            request,
            sendTestEmailCommand(environment, {
              actorEmail: adminEmail.toLowerCase(),
              actorUserId: admin.userId,
              canonicalOrigin: resolveAuthOrigin(environment, request),
              expectedRevision: parsed.data.expectedRevision,
              requestId: parsed.data.requestId,
            }),
          );
          if ('error' in result) {
            return withNoStore(result.error);
          }

          return Response.json(
            { data: result.data },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        },
      )
  );
};

export type CreateAppOptions = {
  /**
   * Fixed subscriber list for best-effort notification events. Production
   * omits this and gets the real email subscriber; tests may pass recording
   * subscribers.
   */
  notificationSubscribers?: readonly LeadCreatedSubscriber[];
};

export const createApp = (environment: Env, options: CreateAppOptions = {}) =>
  createAppWithAuth(
    environment,
    (request) => createAuth(environment, request),
    options,
  );
