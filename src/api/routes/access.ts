import {
  ApiConflictError,
  ApiForbiddenError,
  ApiInternalError,
  ApiNotFoundError,
  ApiServiceUnavailableError,
} from '../errors';
import { rejectUntrustedOrigin } from '../guards';
import { runBoundary } from '../handler-utilities';
import { CurrentStaff } from '../services';
import { toApiTokenView, toInviteView, toStaffAccountView } from '../views';
import { persist } from '@/application/errors';
import { matchesBootstrapToken } from '@/auth';
import {
  checkStaffInviteAvailability,
  createApiToken,
  createStaffInvite,
  type Env,
  isBootstrapGrantAvailable,
  listApiTokens,
  listStaffAccounts,
  listStaffInvites,
  revokeApiToken,
  revokeStaffInvite,
  setStaffAccountDisabled,
} from '@/db/repository';
import {
  type CreateInviteRequest,
  type CreateTokenRequest,
  type SetStaffDisabledRequest,
  type ValidateInviteRequest,
} from '@/domain/schemas';
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';

type InviteValidationOptions = { environment: Env };

type ParametersArguments = RequestArguments & { params: { id: string } };

type PayloadArguments<A> = RequestArguments & { payload: A };

type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

export const createInviteValidationHandlers = (
  options: InviteValidationOptions,
) => {
  const { environment } = options;

  return {
    validateInvite: ({
      payload,
      request,
    }: PayloadArguments<ValidateInviteRequest>) =>
      Effect.gen(function* () {
        const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        const rejected = rejectUntrustedOrigin(environment, web);
        if (rejected !== null) {
          return yield* Effect.fail(
            rejected.status === 403
              ? new ApiForbiddenError({
                  code: 'forbidden',
                  message: 'The request origin is not trusted.',
                })
              : rejected.status === 503
                ? new ApiServiceUnavailableError({
                    code: 'authentication_not_configured',
                    message:
                      'Authentication is not configured on this deployment.',
                  })
                : new ApiInternalError({
                    code: 'internal_error',
                    message: 'The invitation could not be checked.',
                  }),
          );
        }

        const valid = matchesBootstrapToken(environment, payload.token)
          ? yield* persist(() => isBootstrapGrantAvailable(environment)).pipe(
              Effect.mapError(
                () =>
                  new ApiInternalError({
                    code: 'persistence_error',
                    message: 'The invitation could not be checked.',
                  }),
              ),
            )
          : yield* persist(() =>
              checkStaffInviteAvailability(environment, payload.token),
            ).pipe(
              Effect.mapError(
                () =>
                  new ApiInternalError({
                    code: 'persistence_error',
                    message: 'The invitation could not be checked.',
                  }),
              ),
            );
        return valid
          ? { valid: true }
          : yield* Effect.fail(
              new ApiForbiddenError({
                code: 'invite_unavailable',
                message: 'Invitation is unavailable.',
              }),
            );
      }),
  };
};

type AccessHandlerOptions = { environment: Env };

export const createAccessHandlers = (options: AccessHandlerOptions) => {
  const { environment } = options;

  return {
    createInvite: ({
      payload,
      request,
    }: PayloadArguments<CreateInviteRequest>) =>
      Effect.gen(function* () {
        const invite = yield* runBoundary(
          request,
          persist(() =>
            createStaffInvite(environment, payload.name, payload.expiresAt),
          ),
        );
        return {
          data: { ...toInviteView(invite), token: invite.token },
        };
      }),

    createToken: ({ payload, request }: PayloadArguments<CreateTokenRequest>) =>
      Effect.gen(function* () {
        const token = yield* runBoundary(
          request,
          persist(() =>
            createApiToken(environment, {
              expiresAt: payload.expiresAt,
              name: payload.name,
              type: payload.type ?? 'api',
            }),
          ),
        );
        return { data: toApiTokenView(token) };
      }),

    listInvites: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const invites = yield* runBoundary(
          request,
          persist(() => listStaffInvites(environment)),
        );
        return { data: invites.map(toInviteView) };
      }),

    listStaff: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const staff = yield* runBoundary(
          request,
          persist(() => listStaffAccounts(environment)),
        );
        return { data: staff.map(toStaffAccountView) };
      }),

    listTokens: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const tokens = yield* runBoundary(
          request,
          persist(() => listApiTokens(environment)),
        );
        return { data: tokens.map(toApiTokenView) };
      }),

    revokeInvite: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const revoked = yield* runBoundary(
          request,
          persist(() => revokeStaffInvite(environment, params.id)),
        );
        return revoked
          ? undefined
          : yield* Effect.fail(
              new ApiNotFoundError({
                code: 'not_found',
                message: 'Invitation not found.',
              }),
            );
      }),

    revokeToken: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const revoked = yield* runBoundary(
          request,
          persist(() => revokeApiToken(environment, params.id)),
        );
        return revoked
          ? undefined
          : yield* Effect.fail(
              new ApiNotFoundError({
                code: 'not_found',
                message: 'Token not found.',
              }),
            );
      }),

    setStaffDisabled: ({
      params,
      payload,
      request,
    }: ParametersArguments & { payload: SetStaffDisabledRequest }) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        const outcome = yield* runBoundary(
          request,
          persist(() =>
            setStaffAccountDisabled(
              environment,
              params.id,
              payload.disabled,
              staff.adminEmail,
            ),
          ),
        );
        if (outcome.kind === 'not-found') {
          return yield* Effect.fail(
            new ApiNotFoundError({
              code: 'not_found',
              message: 'Staff account not found.',
            }),
          );
        }

        if (outcome.kind === 'self') {
          return yield* Effect.fail(
            new ApiConflictError({
              code: 'conflict',
              message: 'An account cannot disable itself.',
            }),
          );
        }

        if (outcome.kind === 'last-enabled') {
          return yield* Effect.fail(
            new ApiConflictError({
              code: 'conflict',
              message: 'The last enabled staff account cannot be disabled.',
            }),
          );
        }

        return { data: toStaffAccountView(outcome.record) };
      }),
  };
};
