import { createAuthHandler } from './auth-handler';
import { api } from './contracts';
import {
  rejectUntrustedStaffWrite,
  requireAdmin,
  type ResolveStaff,
  type StaffContext,
} from './guards';
import {
  createAccessHandlers,
  createInviteValidationHandlers,
} from './routes/access';
import { createAccountHandlers } from './routes/account';
import { createEmailSettingsHandlers } from './routes/email-settings';
import { createIntakeHandlers } from './routes/intake';
import { createLeadsHandlers } from './routes/leads';
import { createTagsHandlers } from './routes/tags';
import { ApiSchemaErrorsLayer } from './schema-errors';
import { ApiEnvironment, NotificationDispatcher } from './services';
import { StaffAuthLayer } from './staff-auth';
import { requestWaitUntil } from '@/api/execution-context';
import { makeRunRequest, type RouteContext } from '@/api/http';
import { deploymentLayer } from '@/application/deployment';
import { installationConfigStoreLayer } from '@/application/installation-config-store';
import { type Auth, createAuth } from '@/auth';
import { type Env } from '@/db/repository';
import { credentialCipherLayer } from '@/notifications/credential-cipher';
import { emailProviderResolverLayer } from '@/notifications/email-provider';
import {
  createLeadCreatedPublisher,
  type LeadCreatedPublisher,
  type LeadCreatedSubscriber,
  type NotificationRuntime,
} from '@/notifications/events';
import { createLeadCreatedEmailSubscriber } from '@/notifications/lead-created-subscriber';
import { requestTrace } from '@/telemetry/request';
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from 'effect';
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';

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

type HandlerResult = JsonObject | Response | undefined;
type JsonObject = Record<string, unknown>;

const respond = (
  value: HandlerResult,
): HttpServerResponse.HttpServerResponse =>
  value instanceof Response
    ? HttpServerResponse.fromWeb(value)
    : value === undefined
      ? HttpServerResponse.empty()
      : HttpServerResponse.jsonUnsafe(value);

const toHandler =
  <P>(function_: (context: RouteContext<P>) => Promise<HandlerResult>) =>
  (raw: {
    readonly params?: P;
    readonly request: HttpServerRequest.HttpServerRequest;
  }): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.toWeb(raw.request).pipe(
        Effect.orDie,
      );
      const value = yield* Effect.promise(() =>
        function_({ params: (raw.params ?? {}) as P, request }),
      );
      return respond(value);
    });

type StaffHandler<P> = (
  context: RouteContext<P> & { staff: StaffContext },
) => Promise<HandlerResult>;

const withStaff =
  <P>(
    resolveStaff: ResolveStaff,
    function_: StaffHandler<P>,
  ): ((context: RouteContext<P>) => Promise<HandlerResult>) =>
  async (context) => {
    const staff = await resolveStaff(context.request);
    if ('error' in staff) {
      return staff.error;
    }

    return function_({ ...context, staff });
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
      trace: requestTrace(request),
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
  // Staff routes share this one guard. A resolved context is passed directly
  // to each handler, so it stays scoped to that handler and never reaches
  // public routes.
  const resolveStaff: ResolveStaff = async (request) => {
    const admin = await requireAdmin(request, getAuth, environment);
    if (admin.error !== undefined) {
      return { error: admin.error };
    }

    const rejectedWrite = rejectUntrustedStaffWrite(environment, request);
    if (rejectedWrite !== null) {
      return { error: rejectedWrite };
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

  const inviteHandlers = createInviteValidationHandlers({ environment });
  const intakeHandlers = createIntakeHandlers({
    environment,
    eventsFor,
    runRequest,
  });
  const tagHandlers = createTagsHandlers({ environment, runRequest });
  const accessHandlers = createAccessHandlers({ environment });
  const accountHandlers = createAccountHandlers({ environment, runRequest });
  const emailHandlers = createEmailSettingsHandlers({
    environment,
    runRequest,
  });

  const healthLayer = HttpApiBuilder.group(api, 'health', (handlers) =>
    handlers.handleAll({
      health: toHandler(async () => ({ ok: true })),
    }),
  );
  const invitesLayer = HttpApiBuilder.group(api, 'invites', (handlers) =>
    handlers.handleAll({
      validateInvite: toHandler(inviteHandlers.validateInvite),
    }),
  );
  const intakeLayer = HttpApiBuilder.group(api, 'intake', (handlers) =>
    handlers.handleAll({
      createIntake: toHandler(intakeHandlers.createIntake),
      createPublicIntake: toHandler(intakeHandlers.createPublicIntake),
      publicIntakeOptions: toHandler(intakeHandlers.publicIntakeOptions),
    }),
  );
  const serviceLayer = Layer.mergeAll(
    Layer.succeed(ApiEnvironment, environment),
    Layer.succeed(NotificationDispatcher, { runtime, subscribers }),
  );
  const leadsLayer = HttpApiBuilder.group(api, 'leads', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      const dispatcher = yield* NotificationDispatcher;
      return handlers.handleAll(
        createLeadsHandlers({
          dispatcher,
          environment: currentEnvironment,
        }),
      );
    }),
  ).pipe(
    Layer.provide(ApiSchemaErrorsLayer),
    Layer.provide(StaffAuthLayer),
    Layer.provide(serviceLayer),
  );
  const tagsLayer = HttpApiBuilder.group(api, 'tags', (handlers) =>
    handlers.handleAll({
      createTag: toHandler(withStaff(resolveStaff, tagHandlers.createTag)),
      deleteTag: toHandler(withStaff(resolveStaff, tagHandlers.deleteTag)),
      listTags: toHandler(withStaff(resolveStaff, tagHandlers.listTags)),
      updateTag: toHandler(withStaff(resolveStaff, tagHandlers.updateTag)),
      updateTagScope: toHandler(
        withStaff(resolveStaff, tagHandlers.updateTagScope),
      ),
    }),
  );
  const accessLayer = HttpApiBuilder.group(api, 'access', (handlers) =>
    handlers.handleAll({
      createInvite: toHandler(
        withStaff(resolveStaff, accessHandlers.createInvite),
      ),
      createToken: toHandler(
        withStaff(resolveStaff, accessHandlers.createToken),
      ),
      listInvites: toHandler(
        withStaff(resolveStaff, accessHandlers.listInvites),
      ),
      listStaff: toHandler(withStaff(resolveStaff, accessHandlers.listStaff)),
      listTokens: toHandler(withStaff(resolveStaff, accessHandlers.listTokens)),
      revokeInvite: toHandler(
        withStaff(resolveStaff, accessHandlers.revokeInvite),
      ),
      revokeToken: toHandler(
        withStaff(resolveStaff, accessHandlers.revokeToken),
      ),
      setStaffDisabled: toHandler(
        withStaff(resolveStaff, accessHandlers.setStaffDisabled),
      ),
    }),
  );
  const accountLayer = HttpApiBuilder.group(api, 'account', (handlers) =>
    handlers.handleAll({
      getNotificationPreference: toHandler(
        withStaff(resolveStaff, accountHandlers.getNotificationPreference),
      ),
      listSessions: toHandler(
        withStaff(resolveStaff, accountHandlers.listSessions),
      ),
      revokeOtherSessions: toHandler(
        withStaff(resolveStaff, accountHandlers.revokeOtherSessions),
      ),
      revokeSession: toHandler(
        withStaff(resolveStaff, accountHandlers.revokeSession),
      ),
      updateNotificationPreference: toHandler(
        withStaff(resolveStaff, accountHandlers.updateNotificationPreference),
      ),
    }),
  );
  const emailLayer = HttpApiBuilder.group(api, 'email', (handlers) =>
    handlers.handleAll({
      getEmailSettings: toHandler(
        withStaff(resolveStaff, emailHandlers.getEmailSettings),
      ),
      sendTestEmail: toHandler(
        withStaff(resolveStaff, emailHandlers.sendTestEmail),
      ),
      updateEmailSettings: toHandler(
        withStaff(resolveStaff, emailHandlers.updateEmailSettings),
      ),
    }),
  );

  const platformLayer = Layer.mergeAll(
    Etag.layer,
    FileSystem.layerNoop({}),
    Path.layer,
    HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  );
  const apiLayer = HttpApiBuilder.layer(api);
  const appLayer = apiLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        platformLayer,
        healthLayer,
        invitesLayer,
        intakeLayer,
        leadsLayer,
        tagsLayer,
        accessLayer,
        accountLayer,
        emailLayer,
      ),
    ),
  );
  const { handler } = HttpRouter.toWebHandler(appLayer, {
    disableLogger: true,
  });
  const handleAuth = createAuthHandler(environment, getAuth);

  return {
    handle: async (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
        return handleAuth(request);
      }

      return handler(request);
    },
  };
};

export const createApp = (environment: Env, options: CreateAppOptions = {}) =>
  createAppWithAuth(
    environment,
    (request) => createAuth(environment, request),
    options,
  );
