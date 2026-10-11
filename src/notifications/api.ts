/**
 * Browser-side types and calls for the notification APIs. The server views are
 * the source of truth; these types mirror the redacted DTOs the API returns
 * (no credential material is ever part of them).
 */

import { request } from '@/lib/http';

export type CredentialOperation = {
  operation: 'keep' | 'remove' | 'replace';
  value?: string;
};

export type EmailSettingsView = {
  canonicalOrigin: string;
  enabled: boolean;
  environment: {
    hasCloudflareBinding: boolean;
    hasEncryptionKey: boolean;
  };
  fromEmail: null | string;
  fromName: null | string;
  hasApiKey: boolean;
  paused: null | { at: string; reasonCode: null | string; revision: number };
  provider: 'cloudflare' | 'disabled' | 'resend';
  readiness: {
    availability: NotificationAvailability;
    reasonCode: null | string;
  };
  revision: number;
  test: EmailTestView | null;
};

export type EmailTestOutcome =
  'accepted' | 'ambiguous' | 'configuration_error' | 'rejected' | 'sending';

export type EmailTestView = {
  at: null | string;
  outcome: EmailTestOutcome;
  providerMessageId: null | string;
  reasonCode: null | string;
  revision: number;
};

export type NotificationAvailability =
  'configured' | 'disabled' | 'misconfigured' | 'unavailable';

export type NotificationHistory = {
  data: NotificationHistoryItem[];
  nextCursor: null | string;
};

export type NotificationHistoryItem = {
  createdAt: string;
  id: string;
  leadId: string;
  reasonCode: null | string;
  reasonLabel: null | string;
  status:
    | 'accepted'
    | 'claimed'
    | 'failed'
    | 'pending'
    | 'retry'
    | 'sending'
    | 'skipped'
    | 'unknown';
  statusLabel: string;
};

export type NotificationPreference = {
  availability: NotificationAvailability;
  newLeadEmail: boolean;
  provider: NotificationProvider | null;
};

export type NotificationProvider = 'cloudflare' | 'resend';

export type UpdateEmailSettingsInput = {
  credential: CredentialOperation;
  enabled: boolean;
  expectedRevision: number;
  fromEmail: null | string;
  fromName: null | string;
  provider: 'cloudflare' | 'disabled' | 'resend';
};

export const notificationHistoryQueryKey = (userId: string) =>
  ['notification-history', userId] as const;

export const notificationPreferenceQueryKey = (userId: string) =>
  ['notification-preference', userId] as const;

export const emailSettingsQueryKey = ['email-settings'] as const;

export const accountCapabilitiesQueryKey = ['account-capabilities'] as const;

export const notificationsApi = {
  capabilities: () =>
    request<{ manageEmailSettings: boolean }>('/v1/account/capabilities'),
  getPreference: () =>
    request<NotificationPreference>('/v1/account/notifications'),
  getSettings: () => request<EmailSettingsView>('/v1/settings/email'),
  history: (cursor?: string) =>
    request<NotificationHistory>(
      `/v1/account/notifications/history${
        cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      }`,
    ),
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
    request<NotificationPreference>('/v1/account/notifications', {
      body: JSON.stringify({ newLeadEmail }),
      method: 'PUT',
    }),
};
