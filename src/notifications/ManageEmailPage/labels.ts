/**
 * Safe, human labels for the redacted availability and test states. The server
 * never returns provider error bodies, keys, or recipient data; these helpers
 * only translate the closed reason-code set.
 */

import { type EmailTestOutcome } from '../api';

export const READINESS_REASON_LABELS: Record<string, string> = {
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
  paused: 'Sending is paused after a provider configuration error.',
  resend_api_key_missing: 'Add the Resend API key.',
};

export const readinessReasonLabel = (
  reasonCode: null | string,
): null | string =>
  reasonCode === null
    ? null
    : (READINESS_REASON_LABELS[reasonCode] ??
      'The saved configuration is incomplete.');

const PAUSED_REASON_LABELS: Record<string, string> = {
  decrypt_failed:
    'The stored credential cannot be decrypted with the current encryption key.',
  E_SENDER_DOMAIN_NOT_AVAILABLE:
    'The sending domain is not available at the provider.',
  E_SENDER_NOT_VERIFIED: 'The sender domain is not verified at the provider.',
  invalid_api_key: 'The provider API key was rejected.',
  invalid_permission: 'The provider API key is missing a required permission.',
  missing_api_key: 'The provider API key is missing or empty.',
  provider_unavailable: 'The provider configuration is unavailable.',
  resend_api_key_missing: 'The Resend API key is missing.',
  restricted_api_key: 'The provider API key is restricted or inactive.',
  suspended_api_key: 'The provider API key is suspended.',
};

export const pausedReasonLabel = (reasonCode: null | string): string =>
  reasonCode === null
    ? 'Sending is paused after a provider configuration error.'
    : (PAUSED_REASON_LABELS[reasonCode] ??
      'A provider configuration error paused sending.');

export const TEST_OUTCOME_LABELS: Record<EmailTestOutcome, string> = {
  accepted: 'Test accepted by the email service.',
  ambiguous:
    'The test outcome is unknown. Check the provider logs before retrying.',
  configuration_error: 'The provider configuration is incorrect.',
  rejected: 'The email service rejected the test message.',
  sending: 'The test email is in progress.',
};

export const testOutcomeLabel = (outcome: EmailTestOutcome): string =>
  TEST_OUTCOME_LABELS[outcome];
