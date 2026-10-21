import { type StaffContext } from '../guards';
import {
  redactedParse,
  requireRealStaffSession,
  type RouteContext,
  type RunRequest,
  withNoStore,
} from '../http';
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

type EmailSettingsHandlerOptions = {
  environment: Env;
  runRequest: RunRequest;
};

type StaffRoute = RouteContext & { staff: StaffContext };

const readSensitiveBody = async (
  request: Request,
): Promise<{ data: unknown } | { error: Response }> => {
  const text = await request.text();
  if (text.length === 0) {
    return { data: undefined } as const;
  }

  try {
    return { data: JSON.parse(text) } as const;
  } catch {
    return {
      error: Response.json(
        { code: 'validation_error', message: 'The request is invalid.' },
        { headers: { 'Cache-Control': 'no-store' }, status: 422 },
      ),
    } as const;
  }
};

export const createEmailSettingsHandlers = (
  options: EmailSettingsHandlerOptions,
) => {
  const { environment, runRequest } = options;

  return {
    getEmailSettings: async ({ request, staff }: StaffRoute) => {
      const admin = requireRealStaffSession(staff.adminUserId);
      if ('error' in admin) {
        return withNoStore(admin.error);
      }

      const result = await runRequest(
        request,
        getEmailSettingsViewCommand(resolveAuthOrigin(environment, request)),
      );
      if ('error' in result) {
        return withNoStore(result.error);
      }

      return Response.json(
        { data: result.data },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    sendTestEmail: async ({ request, staff }: StaffRoute) => {
      const admin = requireRealStaffSession(staff.adminUserId);
      if ('error' in admin) {
        return withNoStore(admin.error);
      }

      const body = await readSensitiveBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await redactedParse(SendEmailTestRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        sendTestEmailCommand({
          actorEmail: staff.adminEmail.toLowerCase(),
          actorUserId: admin.userId,
          canonicalOrigin: resolveAuthOrigin(environment, request),
          expectedRevision: parsed.data.expectedRevision,
          requestId: parsed.data.requestId,
        }),
      );
      if ('error' in result) {
        return withNoStore(result.error);
      }

      return Response.json(
        { data: result.data },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
    updateEmailSettings: async ({ request, staff }: StaffRoute) => {
      const admin = requireRealStaffSession(staff.adminUserId);
      if ('error' in admin) {
        return withNoStore(admin.error);
      }

      const body = await readSensitiveBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await redactedParse(
        UpdateEmailSettingsRequestSchema,
        body.data,
      );
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        updateEmailSettingsCommand({
          actorUserId: admin.userId,
          canonicalOrigin: resolveAuthOrigin(environment, request),
          credential: parsed.data.credential,
          expectedRevision: parsed.data.expectedRevision,
          fromEmail: parsed.data.fromEmail ?? null,
          fromName: parsed.data.fromName ?? null,
          provider: parsed.data.provider,
        }),
      );
      if ('error' in result) {
        return withNoStore(result.error);
      }

      return Response.json(
        { data: result.data },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    },
  };
};
