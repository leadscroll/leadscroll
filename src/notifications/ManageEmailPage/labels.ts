/**
 * Safe, human labels for the redacted availability and test states. The server
 * never returns provider error bodies, keys, or recipient data; these helpers
 * only translate the closed reason-code set.
 */

import { type EmailTestOutcome } from '../api';

export const READINESS_REASON_LABELS: Record<string, string> = {
  canonical_origin_missing:
    'The application URL is missing. Save the settings again from the app.',
  cloudflare_binding_missing:
    'The Cloudflare EMAIL binding is not present in this deployment.',
  decrypt_failed:
    'The stored credential cannot be decrypted with the current encryption key.',
  disabled: 'Email sending is turned off.',
  encryption_key_invalid:
    'EMAIL_SETTINGS_ENCRYPTION_KEY is not a valid 32-byte base64 or hex key.',
  encryption_key_missing:
    'EMAIL_SETTINGS_ENCRYPTION_KEY is not configured; Resend keys cannot be saved.',
  from_email_missing: 'Set the sender address.',
  resend_api_key_missing: 'Add the Resend API key.',
};

export const readinessReasonLabel = (
  reasonCode: null | string,
): null | string =>
  reasonCode === null
    ? null
    : (READINESS_REASON_LABELS[reasonCode] ??
      'The saved configuration is incomplete.');

export const TEST_OUTCOME_LABELS: Record<EmailTestOutcome, string> = {
  accepted: 'Test accepted by the email service.',
  ambiguous:
    'The test outcome is unknown. Check the provider logs before sending another test.',
  configuration_error: 'The provider configuration is incorrect.',
  rejected: 'The email service rejected the test message.',
  sending: 'The test email is in progress.',
};

export const testOutcomeLabel = (outcome: EmailTestOutcome): string =>
  TEST_OUTCOME_LABELS[outcome];
