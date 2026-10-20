import { createAuthHandler } from './auth-handler';
import { api } from './contracts';
import { PUBLIC_CORS_HEADERS } from './http';
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
import { deploymentLayer } from '@/application/deployment';
import { installationConfigStoreLayer } from '@/application/installation-config-store';
import { type Auth, createAuth } from '@/auth';
import { type Env } from '@/db/repository';
import { credentialCipherLayer } from '@/notifications/credential-cipher';
import { emailProviderResolverLayer } from '@/notifications/email-provider';
import {
  type LeadCreatedSubscriber,
  type NotificationRuntime,
} from '@/notifications/events';
import { createLeadCreatedEmailSubscriber } from '@/notifications/lead-created-subscriber';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
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
  const serviceLayer = Layer.mergeAll(
    Layer.succeed(ApiEnvironment, environment),
    Layer.succeed(NotificationDispatcher, { runtime, subscribers }),
  );
  const healthLayer = HttpApiBuilder.group(api, 'health', (handlers) =>
    handlers.handleAll({
      health: () => Effect.succeed({ ok: true }),
    }),
  );
  const invitesLayer = HttpApiBuilder.group(api, 'invites', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      return handlers.handleAll(
        createInviteValidationHandlers({ environment: currentEnvironment }),
      );
    }),
  ).pipe(Layer.provide(ApiSchemaErrorsLayer), Layer.provide(serviceLayer));
  const intakeLayer = HttpApiBuilder.group(api, 'intake', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      const dispatcher = yield* NotificationDispatcher;
      const implementations = createIntakeHandlers({
        dispatcher,
        environment: currentEnvironment,
      });
      return handlers
        .handleRaw('createIntake', implementations.createIntake)
        .handleRaw('createPublicIntake', implementations.createPublicIntake)
        .handle('publicIntakeOptions', implementations.publicIntakeOptions);
    }),
  ).pipe(Layer.provide(ApiSchemaErrorsLayer), Layer.provide(serviceLayer));
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
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      return handlers.handleAll(
        createTagsHandlers({ environment: currentEnvironment }),
      );
    }),
  ).pipe(
    Layer.provide(ApiSchemaErrorsLayer),
    Layer.provide(StaffAuthLayer),
    Layer.provide(serviceLayer),
  );
  const accessLayer = HttpApiBuilder.group(api, 'access', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      return handlers.handleAll(
        createAccessHandlers({ environment: currentEnvironment }),
      );
    }),
  ).pipe(
    Layer.provide(ApiSchemaErrorsLayer),
    Layer.provide(StaffAuthLayer),
    Layer.provide(serviceLayer),
  );
  const accountLayer = HttpApiBuilder.group(api, 'account', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      const dispatcher = yield* NotificationDispatcher;
      return handlers.handleAll(
        createAccountHandlers({
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
  const emailLayer = HttpApiBuilder.group(api, 'email', (handlers) =>
    Effect.gen(function* () {
      const currentEnvironment = yield* ApiEnvironment;
      const dispatcher = yield* NotificationDispatcher;
      const implementations = createEmailSettingsHandlers({
        dispatcher,
        environment: currentEnvironment,
      });
      return handlers
        .handle('getEmailSettings', implementations.getEmailSettings)
        .handleRaw('updateEmailSettings', implementations.updateEmailSettings)
        .handleRaw('sendTestEmail', implementations.sendTestEmail);
    }),
  ).pipe(
    Layer.provide(ApiSchemaErrorsLayer),
    Layer.provide(StaffAuthLayer),
    Layer.provide(serviceLayer),
  );

  const apiLayer = HttpApiBuilder.layer(api);
  const appLayer = apiLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        HttpServer.layerServices,
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

      const response = await handler(request);
      const headers = new Headers(response.headers);
      if (
        pathname === '/v1/settings/email' ||
        pathname.startsWith('/v1/settings/email/')
      ) {
        headers.set('cache-control', 'no-store');
      }

      if (
        pathname === '/v1/public/intakes' ||
        pathname.startsWith('/v1/public/intakes/')
      ) {
        for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
          headers.set(name, value);
        }
      }

      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
};

export const createApp = (environment: Env, options: CreateAppOptions = {}) =>
  createAppWithAuth(
    environment,
    (request) => createAuth(environment, request),
    options,
  );
