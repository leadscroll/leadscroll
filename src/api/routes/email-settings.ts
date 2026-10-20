import {
  ApiServiceUnavailableError,
  ApiUnauthorizedError,
  ApiValidationError,
} from '../errors';
import { runBoundary, webRequest } from '../handler-utilities';
import {
  CurrentStaff,
  type NotificationDispatcherShape,
  withNotificationServices,
} from '../services';
import {
  getEmailSettingsViewCommand,
  updateEmailSettingsCommand,
} from '@/application/notification-settings';
import { sendTestEmailCommand } from '@/application/notification-test-send';
import { resolveAuthOrigin } from '@/auth';
import { type Env } from '@/db/repository';
import {
  SendEmailTestRequestSchema,
  UpdateEmailSettingsRequestSchema,
} from '@/domain/schemas';
import { Effect, Schema } from 'effect';
import { type HttpServerRequest } from 'effect/http';

type HandlerOptions = {
  dispatcher: NotificationDispatcherShape;
  environment: Env;
};

type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

const validationError = () =>
  new ApiValidationError({
    code: 'validation_error',
    message: 'The request is invalid.',
  });

const canonicalOrigin = (environment: Env, request: Request) =>
  Effect.try({
    catch: () =>
      new ApiServiceUnavailableError({
        code: 'authentication_not_configured',
        message: 'Authentication is not configured on this deployment.',
      }),
    try: () => resolveAuthOrigin(environment, request),
  });

const readSensitiveBody = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Codec<A, I>,
): Effect.Effect<
  { data: A; web: Request },
  ReturnType<typeof validationError>
> =>
  Effect.gen(function* () {
    const web = yield* webRequest(request);
    const text = yield* Effect.promise(() => web.text());
    const json = yield* Effect.try({
      catch: validationError,
      try: () => JSON.parse(text) as unknown,
    });
    const data = yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(validationError),
    );
    return { data, web };
  });

const requireSession = (adminUserId: null | string) =>
  adminUserId === null
    ? Effect.fail(
        new ApiUnauthorizedError({
          code: 'unauthorized',
          message: 'A real session is required.',
        }),
      )
    : Effect.succeed(adminUserId);

export const createEmailSettingsHandlers = (options: HandlerOptions) => {
  const { dispatcher, environment } = options;

  return {
    getEmailSettings: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        yield* requireSession(staff.adminUserId);
        const web = yield* webRequest(request);
        const origin = yield* canonicalOrigin(environment, web);
        const view = yield* runBoundary(
          request,
          withNotificationServices(
            dispatcher,
            getEmailSettingsViewCommand(origin),
          ),
        );
        return { data: view };
      }),

    sendTestEmail: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        const adminUserId = yield* requireSession(staff.adminUserId);
        const body = yield* readSensitiveBody(
          request,
          SendEmailTestRequestSchema,
        );
        const origin = yield* canonicalOrigin(environment, body.web);
        const view = yield* runBoundary(
          request,
          withNotificationServices(
            dispatcher,
            sendTestEmailCommand({
              actorEmail: staff.adminEmail.toLowerCase(),
              actorUserId: adminUserId,
              canonicalOrigin: origin,
              expectedRevision: body.data.expectedRevision,
              requestId: body.data.requestId,
            }),
          ),
        );
        return { data: view };
      }),

    updateEmailSettings: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        const adminUserId = yield* requireSession(staff.adminUserId);
        const body = yield* readSensitiveBody(
          request,
          UpdateEmailSettingsRequestSchema,
        );
        const origin = yield* canonicalOrigin(environment, body.web);
        const view = yield* runBoundary(
          request,
          withNotificationServices(
            dispatcher,
            updateEmailSettingsCommand({
              actorUserId: adminUserId,
              canonicalOrigin: origin,
              credential: body.data.credential,
              expectedRevision: body.data.expectedRevision,
              fromEmail: body.data.fromEmail ?? null,
              fromName: body.data.fromName ?? null,
              provider: body.data.provider,
            }),
          ),
        );
        return { data: view };
      }),
  };
};
