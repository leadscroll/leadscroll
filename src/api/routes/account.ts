import { type StaffContext } from '../guards';
import {
  errorResponse,
  parse,
  readJsonBody,
  type RouteContext,
  type RunRequest,
} from '../http';
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

export type IdParameters = { id: string };

type AccountHandlerOptions = {
  environment: Env;
  runRequest: RunRequest;
};

type StaffRoute<P = Record<string, never>> = RouteContext<P> & {
  staff: StaffContext;
};

export const createAccountHandlers = (options: AccountHandlerOptions) => {
  const { environment, runRequest } = options;

  return {
    getNotificationPreference: async ({ request, staff }: StaffRoute) => {
      if (staff.adminUserId === null) {
        return errorResponse(
          401,
          'unauthorized',
          'A real session is required.',
        );
      }

      const result = await runRequest(
        request,
        getNotificationPreferenceView(environment, staff.adminUserId),
      );
      return 'error' in result ? result.error : { data: result.data };
    },
    listSessions: async ({ request, staff }: StaffRoute) => {
      if (!staff.adminSession) {
        return errorResponse(
          401,
          'unauthorized',
          'A real session is required.',
        );
      }

      const result = await runRequest(
        request,
        listAccountSessionsCommand(environment, staff.adminSession),
      );
      return 'error' in result ? result.error : { data: result.data };
    },
    revokeOtherSessions: async ({ request, staff }: StaffRoute) => {
      if (!staff.adminSession) {
        return errorResponse(
          401,
          'unauthorized',
          'A real session is required.',
        );
      }

      const result = await runRequest(
        request,
        revokeOtherAccountSessionsCommand(environment, staff.adminSession),
      );
      return 'error' in result
        ? result.error
        : { data: { revoked: result.data } };
    },
    revokeSession: async ({
      params,
      request,
      staff,
    }: StaffRoute<IdParameters>) => {
      if (!staff.adminSession) {
        return errorResponse(
          401,
          'unauthorized',
          'A real session is required.',
        );
      }

      const result = await runRequest(
        request,
        revokeAccountSessionCommand(environment, staff.adminSession, params.id),
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
    updateNotificationPreference: async ({ request, staff }: StaffRoute) => {
      if (staff.adminUserId === null) {
        return errorResponse(
          401,
          'unauthorized',
          'A real session is required.',
        );
      }

      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(
        UpdateNotificationPreferenceRequestSchema,
        body.data,
      );
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        updateNotificationPreferenceCommand(
          environment,
          staff.adminUserId,
          parsed.data.newLeadEmail,
        ),
      );
      return 'error' in result ? result.error : { data: result.data };
    },
  };
};
