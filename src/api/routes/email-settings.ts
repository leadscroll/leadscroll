import { type ResolveStaff } from '../guards';
import {
  redactedParse,
  requireRealStaffSession,
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
import { Elysia } from 'elysia';

type EmailSettingsRoutesOptions = {
  environment: Env;
  resolveStaff: ResolveStaff;
  runRequest: RunRequest;
};

export const createEmailSettingsRoutes = (
  options: EmailSettingsRoutesOptions,
) => {
  const { environment, resolveStaff, runRequest } = options;

  return (
    new Elysia({ name: 'email-settings-routes' })
      .resolve(({ request }) => resolveStaff(request))
      // Installation email settings. The shared staff session guard above
      // already enforces authentication, disabled accounts, trusted writes,
      // and JSON bodies; every enabled staff account may manage the
      // installation's email configuration.
      .get('/v1/settings/email', async ({ adminUserId, request }) => {
        const admin = requireRealStaffSession(adminUserId);
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
      })
      .put('/v1/settings/email', async ({ adminUserId, body, request }) => {
        const admin = requireRealStaffSession(adminUserId);
        if ('error' in admin) {
          return withNoStore(admin.error);
        }

        const parsed = await redactedParse(
          UpdateEmailSettingsRequestSchema,
          body,
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
            enabled: parsed.data.enabled,
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
      })
      .post(
        '/v1/settings/email/test',
        async ({ adminEmail, adminUserId, body, request }) => {
          const admin = requireRealStaffSession(adminUserId);
          if ('error' in admin) {
            return withNoStore(admin.error);
          }

          const parsed = await redactedParse(SendEmailTestRequestSchema, body);
          if ('error' in parsed) {
            return parsed.error;
          }

          const result = await runRequest(
            request,
            sendTestEmailCommand({
              actorEmail: adminEmail.toLowerCase(),
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
      )
  );
};
