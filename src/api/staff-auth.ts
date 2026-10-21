/**
 * Staff authentication/authorization middleware for the typed HTTP API.
 *
 * It converts the framework guards' Response-based outcomes into the public
 * `Api*Error` classes so middleware failures participate in the same typed
 * error contract as endpoint handlers.
 */

import {
  ApiForbiddenError,
  ApiInternalError,
  ApiServiceUnavailableError,
  ApiUnauthorizedError,
  ApiUnsupportedMediaTypeError,
  StaffAuthErrors,
} from './errors';
import { rejectUntrustedStaffWrite, requireAdmin } from './guards';
import {
  ApiEnvironment,
  CurrentStaff,
  CurrentStaffSession,
  CurrentStaffUser,
} from './services';
import { createAuth } from '@/auth';
import { type Env } from '@/db/env';
import { Effect, Layer } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiMiddleware } from 'effect/http-api';

export class StaffAuth extends HttpApiMiddleware.Service<
  StaffAuth,
  {
    error: typeof StaffAuthErrors;
    provides: CurrentStaff;
    requires: ApiEnvironment;
  }
>()('leadscroll/api/StaffAuth', { error: StaffAuthErrors }) {}

const authFailure = (status: number) => {
  switch (status) {
    case 401:
      return new ApiUnauthorizedError({
        code: 'unauthorized',
        message: 'A valid staff session is required.',
      });
    case 403:
      return new ApiForbiddenError({
        code: 'forbidden',
        message: 'The request origin is not trusted.',
      });
    case 415:
      return new ApiUnsupportedMediaTypeError({
        code: 'unsupported_media_type',
        message: 'Staff requests with a body must use application/json.',
      });
    case 503:
      return new ApiServiceUnavailableError({
        code: 'authentication_not_configured',
        message: 'Authentication is not configured on this deployment.',
      });
    default:
      return new ApiInternalError({
        code: 'authentication_unavailable',
        message: 'Authentication could not be checked. Please try again.',
      });
  }
};

const authenticate = (environment: Env) =>
  Effect.gen(function* () {
    const serverRequest = yield* HttpServerRequest.HttpServerRequest;
    const request = yield* HttpServerRequest.toWeb(serverRequest).pipe(
      Effect.orDie,
    );

    const admin = yield* Effect.promise(() =>
      requireAdmin(
        request,
        (current) => createAuth(environment, current),
        environment,
      ),
    );
    if (admin.error !== undefined) {
      return yield* Effect.fail(authFailure(admin.error.status));
    }

    const rejectedWrite = rejectUntrustedStaffWrite(environment, request);
    if (rejectedWrite !== null) {
      return yield* Effect.fail(authFailure(rejectedWrite.status));
    }

    return {
      adminEmail: admin.identity.email,
      adminSession: admin.identity.session,
      adminUserId: admin.identity.userId,
    };
  });

export class StaffSession extends HttpApiMiddleware.Service<
  StaffSession,
  {
    error: typeof StaffAuthErrors;
    provides: CurrentStaffSession;
    requires: ApiEnvironment;
  }
>()('leadscroll/api/StaffSession', { error: StaffAuthErrors }) {}

export const StaffSessionLayer = Layer.effect(
  StaffSession,
  Effect.gen(function* () {
    const environment = yield* ApiEnvironment;
    return StaffSession.of((httpEffect) =>
      Effect.gen(function* () {
        const staff = yield* authenticate(environment);
        if (!staff.adminSession) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        return yield* Effect.provideService(httpEffect, CurrentStaffSession, {
          ...staff,
          adminSession: staff.adminSession,
        });
      }),
    );
  }),
);

export class StaffUser extends HttpApiMiddleware.Service<
  StaffUser,
  {
    error: typeof StaffAuthErrors;
    provides: CurrentStaffUser;
    requires: ApiEnvironment;
  }
>()('leadscroll/api/StaffUser', { error: StaffAuthErrors }) {}

export const StaffUserLayer = Layer.effect(
  StaffUser,
  Effect.gen(function* () {
    const environment = yield* ApiEnvironment;
    return StaffUser.of((httpEffect) =>
      Effect.gen(function* () {
        const staff = yield* authenticate(environment);
        if (staff.adminUserId === null) {
          return yield* Effect.fail(
            new ApiUnauthorizedError({
              code: 'unauthorized',
              message: 'A real session is required.',
            }),
          );
        }

        return yield* Effect.provideService(httpEffect, CurrentStaffUser, {
          ...staff,
          adminUserId: staff.adminUserId,
        });
      }),
    );
  }),
);

export const StaffAuthLayer = Layer.effect(
  StaffAuth,
  Effect.gen(function* () {
    const environment = yield* ApiEnvironment;

    return StaffAuth.of((httpEffect) =>
      Effect.gen(function* () {
        const staff = yield* authenticate(environment);
        return yield* Effect.provideService(httpEffect, CurrentStaff, staff);
      }),
    );
  }),
);
