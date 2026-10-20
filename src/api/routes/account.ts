import {
  ApiConflictError,
  ApiNotFoundError,
  ApiUnauthorizedError,
} from '../errors';
import { runBoundary } from '../handler-utilities';
import {
  CurrentStaff,
  type NotificationDispatcherShape,
  withNotificationServices,
} from '../services';
import {
  listAccountSessionsCommand,
  revokeAccountSessionCommand,
  revokeOtherAccountSessionsCommand,
} from '@/application/account-commands';
import {
  getNotificationPreferenceView,
  updateNotificationPreferenceCommand,
} from '@/application/notification-preferences';
import { type Env } from '@/db/repository';
import { Effect } from 'effect';
import { type HttpServerRequest } from 'effect/http';

type HandlerOptions = {
  dispatcher: NotificationDispatcherShape;
  environment: Env;
};

type ParametersArguments = RequestArguments & { params: { id: string } };

type PayloadArguments<A> = RequestArguments & { payload: A };

type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

export const createAccountHandlers = (options: HandlerOptions) => {
  const { dispatcher, environment } = options;

  return {
    getNotificationPreference: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        if (staff.adminUserId === null) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        const preference = yield* runBoundary(
          request,
          withNotificationServices(
            dispatcher,
            getNotificationPreferenceView(environment, staff.adminUserId),
          ),
        );
        return { data: preference };
      }),

    listSessions: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        if (!staff.adminSession) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        const sessions = yield* runBoundary(
          request,
          listAccountSessionsCommand(environment, staff.adminSession),
        );
        return { data: sessions };
      }),

    revokeOtherSessions: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        if (!staff.adminSession) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        const revoked = yield* runBoundary(
          request,
          revokeOtherAccountSessionsCommand(environment, staff.adminSession),
        );
        return { data: { revoked } };
      }),

    revokeSession: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        if (!staff.adminSession) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        const outcome = yield* runBoundary(
          request,
          revokeAccountSessionCommand(
            environment,
            staff.adminSession,
            params.id,
          ),
        );
        if (outcome === 'current') {
          return yield* Effect.fail(
            new ApiConflictError({
              code: 'conflict',
              message:
                'The current session cannot revoke itself; use sign out instead.',
            }),
          );
        }

        if (outcome === 'missing') {
          return yield* Effect.fail(
            new ApiNotFoundError({
              code: 'not_found',
              message: 'Session not found.',
            }),
          );
        }

        return undefined;
      }),

    updateNotificationPreference: ({
      payload,
      request,
    }: PayloadArguments<{ newLeadEmail: boolean }>) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        if (staff.adminUserId === null) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        const preference = yield* runBoundary(
          request,
          withNotificationServices(
            dispatcher,
            updateNotificationPreferenceCommand(
              environment,
              staff.adminUserId,
              payload.newLeadEmail,
            ),
          ),
        );
        return { data: preference };
      }),
  };
};
