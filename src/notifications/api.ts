/**
 * Browser-side calls for the notification APIs. View types are derived from
 * the authoritative Effect schemas (type-only imports, so no server module is
 * bundled) and query keys are scoped by the signed-in user so two identities
 * in the same SPA can never share cached settings or preferences.
 */

import {
  type EmailSettingsView,
  type EmailTestView,
  type NotificationPreferenceView,
  type UpdateEmailSettingsRequest,
} from '@/domain/schemas';
import { request } from '@/lib/http';

export type UpdateEmailSettingsInput = UpdateEmailSettingsRequest;

export {
  emailSettingsQueryKey,
  notificationPreferenceQueryKey,
  type SavedConfigurationTest,
  savedConfigurationTestable,
} from './queryKeys';

export type {
  EmailSettingsView,
  EmailTestOutcome,
  EmailTestView,
  NotificationPreferenceView,
} from '@/domain/schemas';

export const notificationsApi = {
  getPreference: () =>
    request<NotificationPreferenceView>('/v1/account/notifications'),
  getSettings: () => request<EmailSettingsView>('/v1/settings/email'),
  saveSettings: (input: UpdateEmailSettingsInput) =>
    request<EmailSettingsView>('/v1/settings/email', {
      body: JSON.stringify(input),
      method: 'PUT',
    }),
  sendTest: (expectedRevision: number, requestId: string) =>
    request<EmailTestView>('/v1/settings/email/test', {
      body: JSON.stringify({ expectedRevision, requestId }),
      method: 'POST',
    }),
  updatePreference: (newLeadEmail: boolean) =>
    request<NotificationPreferenceView>('/v1/account/notifications', {
      body: JSON.stringify({ newLeadEmail }),
      method: 'PUT',
    }),
};
