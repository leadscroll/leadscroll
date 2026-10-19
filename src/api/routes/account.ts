import { type ResolveStaff } from '../guards';
import { errorResponse, parse, type RunRequest } from '../http';
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
import { UpdateNotificationPreferenceRequestSchema } from '@/domain/schemas';
import { Elysia } from 'elysia';

type AccountRoutesOptions = {
  environment: Env;
  resolveStaff: ResolveStaff;
  runRequest: RunRequest;
};

export const createAccountRoutes = (options: AccountRoutesOptions) => {
  const { environment, resolveStaff, runRequest } = options;

  return (
    new Elysia({ name: 'account-routes' })
      .resolve(({ request }) => resolveStaff(request))
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

        const result = await runRequest(
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

          const result = await runRequest(
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

          const result = await runRequest(
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
      .get('/v1/account/notifications', async ({ adminUserId, request }) => {
        if (adminUserId === null) {
          return errorResponse(
            401,
            'unauthorized',
            'A real session is required.',
          );
        }

        const result = await runRequest(
          request,
          getNotificationPreferenceView(environment, adminUserId),
        );
        return 'error' in result ? result.error : { data: result.data };
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

          const result = await runRequest(
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
  );
};
