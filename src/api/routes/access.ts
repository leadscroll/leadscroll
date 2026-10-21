import { rejectUntrustedOrigin, type StaffContext } from '../guards';
import { errorResponse, parse, readJsonBody, type RouteContext } from '../http';
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
  CreateInviteRequestSchema,
  CreateTokenRequestSchema,
  SetStaffDisabledRequestSchema,
  ValidateInviteRequestSchema,
} from '@/domain/schemas';

export type IdParameters = { id: string };

type InviteValidationOptions = {
  environment: Env;
};

type StaffRoute<P = Record<string, never>> = RouteContext<P> & {
  staff: StaffContext;
};

export const createInviteValidationHandlers = (
  options: InviteValidationOptions,
) => {
  const { environment } = options;

  return {
    validateInvite: async ({ request }: RouteContext) => {
      const rejectedOrigin = rejectUntrustedOrigin(environment, request);
      if (rejectedOrigin !== null) {
        return rejectedOrigin;
      }

      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(ValidateInviteRequestSchema, body.data);
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
    },
  };
};

type AccessHandlerOptions = {
  environment: Env;
};

export const createAccessHandlers = (options: AccessHandlerOptions) => {
  const { environment } = options;

  return {
    createInvite: async ({ request }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(CreateInviteRequestSchema, body.data);
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
    },
    createToken: async ({ request }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(CreateTokenRequestSchema, body.data);
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
    },
    listInvites: async () => {
      return { data: await listStaffInvites(environment) };
    },
    listStaff: async () => {
      return { data: await listStaffAccounts(environment) };
    },
    listTokens: async () => {
      return { data: await listApiTokens(environment) };
    },
    revokeInvite: async ({ params }: StaffRoute<IdParameters>) => {
      return (await revokeStaffInvite(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Invitation not found.');
    },
    revokeToken: async ({ params }: StaffRoute<IdParameters>) => {
      return (await revokeApiToken(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Token not found.');
    },
    setStaffDisabled: async ({
      params,
      request,
      staff,
    }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(SetStaffDisabledRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const outcome = await setStaffAccountDisabled(
        environment,
        params.id,
        parsed.data.disabled,
        staff.adminEmail,
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
    },
  };
};
