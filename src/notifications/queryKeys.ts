/**
 * Pure query-key and readiness helpers for the notification UI. Kept free of
 * transport imports so tests (and non-browser code) can import them without a
 * DOM environment.
 */

import { type EmailSettingsView } from '@/domain/schemas';

export const notificationPreferenceQueryKey = (userId: string) =>
  ['notification-preference', userId] as const;

export const emailSettingsQueryKey = (userId: string) =>
  ['email-settings', userId] as const;

export const accountCapabilitiesQueryKey = (userId: string) =>
  ['account-capabilities', userId] as const;

export type SavedConfigurationTest =
  { message: string; ok: false } | { ok: true };

/**
 * Whether the saved provider configuration can produce a test message. The
 * installation enable switch being off does not block an explicit test:
 * testing is how setup is confirmed without turning live alerts on.
 */
export const savedConfigurationTestable = (
  settings: EmailSettingsView,
): SavedConfigurationTest => {
  if (settings.provider === 'disabled') {
    return { message: 'Choose a provider first.', ok: false };
  }

  if (settings.fromEmail === null || settings.fromEmail.trim().length === 0) {
    return { message: 'Set the sender address first.', ok: false };
  }

  if (
    settings.provider === 'cloudflare' &&
    !settings.environment.hasCloudflareBinding
  ) {
    return {
      message:
        'The Cloudflare EMAIL binding is not present in this deployment.',
      ok: false,
    };
  }

  if (settings.provider === 'resend' && !settings.hasApiKey) {
    return { message: 'Add the Resend API key first.', ok: false };
  }

  if (
    settings.provider === 'resend' &&
    !settings.environment.hasEncryptionKey
  ) {
    return {
      message: 'The credential encryption key is not configured.',
      ok: false,
    };
  }

  return { ok: true };
};
