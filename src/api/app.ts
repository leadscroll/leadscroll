import {
  rejectUntrustedStaffWrite,
  requireAdmin,
  type ResolveStaff,
} from './guards';
import { errorResponse, makeRunRequest, withNoStore } from './http';
import {
  createAccessRoutes,
  createInviteValidationRoutes,
} from './routes/access';
import { createAccountRoutes } from './routes/account';
import { createEmailSettingsRoutes } from './routes/email-settings';
import { createIntakeRoutes } from './routes/intake';
import { createLeadsRoutes } from './routes/leads';
import { createTagsRoutes } from './routes/tags';
import { requestWaitUntil } from '@/api/execution-context';
import { deploymentLayer } from '@/application/deployment';
import { installationConfigStoreLayer } from '@/application/installation-config-store';
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
  createAuth,
} from '@/auth';
import { createAccountAuthEndpoints } from '@/auth/account-management';
import { handleInvitationSignUp } from '@/auth/invitation-sign-up';
import {
  blockedRetryAfter,
  rateLimitedResponse,
  rememberBlocked,
} from '@/auth/rate-limit-cache';
import { handleDisabledAccountSignIn } from '@/auth/sign-in-guard';
import { type Env } from '@/db/repository';
import { HealthSchema } from '@/domain/schemas';
import { credentialCipherLayer } from '@/notifications/credential-cipher';
import { emailProviderResolverLayer } from '@/notifications/email-provider';
import {
  createLeadCreatedPublisher,
  type LeadCreatedPublisher,
  type LeadCreatedSubscriber,
  type NotificationRuntime,
} from '@/notifications/events';
import { createLeadCreatedEmailSubscriber } from '@/notifications/lead-created-subscriber';
import { Layer, ManagedRuntime, Schema } from 'effect';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';

export type CreateAppOptions = {
  /**
   * Composition runtime for notification services. Tests may provide a
   * runtime with test provider/store layers; production omits it.
   */
  notificationRuntime?: NotificationRuntime;
  /**
   * Fixed subscriber list for best-effort notification events. Production
   * omits this and gets the real email subscriber; tests may pass recording
   * subscribers.
   */
  notificationSubscribers?: readonly LeadCreatedSubscriber[];
};

const createAppWithAuth = (
  environment: Env,
  getAuth: (request: Request) => Auth,
  options: CreateAppOptions = {},
) => {
  // One composition runtime provides the configuration store, deployment
  // capabilities, credential cipher, and provider resolver to every request
  // effect. Subscribers are registered once at composition time; every
  // request builds only a small scoped publisher around the Worker execution
  // context.
  const notificationServices = emailProviderResolverLayer(environment).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        installationConfigStoreLayer(environment),
        deploymentLayer(environment),
        credentialCipherLayer(environment),
      ),
    ),
  );
  const runtime =
    options.notificationRuntime ?? ManagedRuntime.make(notificationServices);
  const subscribers: readonly LeadCreatedSubscriber[] =
    options.notificationSubscribers ?? [
      createLeadCreatedEmailSubscriber(environment),
    ];
  const eventsFor = (request: Request): LeadCreatedPublisher =>
    createLeadCreatedPublisher({
      runtime,
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
  const runRequest = makeRunRequest(runtime);
  // Staff routes share this one guard. Each staff plugin applies it directly
  // before registering its own routes, so the resolved context stays scoped
  // to that plugin and never reaches public routes.
  const resolveStaff: ResolveStaff = async (request) => {
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
      // The account-sessions routes need the caller's own session row; no raw
      // token is propagated into application context.
      adminSession: admin.identity.session,
      // Durable account id, used for self-suppression and per-user
      // notification state. Null for the development bypass when no matching
      // account row exists; such routes fail closed.
      adminUserId: admin.identity.userId,
    };
  };

  const accountEndpoints = createAccountAuthEndpoints(getAuth, environment);

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
      .use(createIntakeRoutes({ environment, eventsFor, runRequest }))
      .use(createInviteValidationRoutes({ environment }))
      .use(
        createLeadsRoutes({
          environment,
          eventsFor,
          resolveStaff,
          runRequest,
        }),
      )
      .use(createTagsRoutes({ environment, resolveStaff, runRequest }))
      .use(createAccessRoutes({ environment, resolveStaff }))
      .use(createAccountRoutes({ environment, resolveStaff, runRequest }))
      .use(createEmailSettingsRoutes({ environment, resolveStaff, runRequest }))
  );
};

export const createApp = (environment: Env, options: CreateAppOptions = {}) =>
  createAppWithAuth(
    environment,
    (request) => createAuth(environment, request),
    options,
  );
