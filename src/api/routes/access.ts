import { rejectUntrustedOrigin, type ResolveStaff } from '../guards';
import { errorResponse, parse } from '../http';
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
import { Elysia } from 'elysia';

type InviteValidationRoutesOptions = {
  environment: Env;
};

export const createInviteValidationRoutes = (
  options: InviteValidationRoutesOptions,
) => {
  const { environment } = options;

  return new Elysia({ name: 'invite-validation-routes' }).post(
    '/api/invites/validate',
    async ({ body, request }) => {
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
    },
  );
};

type AccessRoutesOptions = {
  environment: Env;
  resolveStaff: ResolveStaff;
};

export const createAccessRoutes = (options: AccessRoutesOptions) => {
  const { environment, resolveStaff } = options;

  return new Elysia({ name: 'access-routes' })
    .resolve(({ request }) => resolveStaff(request))
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
    });
};
