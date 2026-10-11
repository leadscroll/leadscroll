/**
 * Cloudflare Email Sending adapter (native `send_email` binding).
 *
 * The binding has no documented request-level idempotency and no capability
 * probe, so a transport/internal failure at the binding boundary is
 * `ambiguous`: the same notification is never blindly re-submitted, and the
 * delivery command records an unknown outcome for operator reconciliation.
 * Documented error codes with a definitive meaning are normalized into
 * permanent or retryable rejections.
 */

import {
  type ConfigurationCheck,
  type EmailEnvelope,
  type EmailSender,
  type SendResult,
} from '../email';

/**
 * Binding contract from `@cloudflare/workers-types`. Only the structured
 * `send(builder)` overload is used; the adapter never constructs raw MIME.
 */
export type CloudflareEmailBinding = Pick<SendEmail, 'send'>;

const RETRYABLE_ERROR_CODES = new Set([
  'E_DAILY_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_RATE_LIMIT_EXCEEDED',
]);

const PERMANENT_ERROR_CODES = new Set([
  'E_CONTENT_TOO_LARGE',
  'E_FIELD_MISSING',
  'E_HEADER_NAME_INVALID',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_SENDER_NOT_VERIFIED',
  'E_TOO_MANY_RECIPIENTS',
  'E_VALIDATION_ERROR',
]);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};

/**
 * Maps a binding rejection onto the normalized contract. Known definitive
 * codes never become ambiguous; `E_INTERNAL_SERVER_ERROR` and unknown codes
 * are ambiguous because acceptance cannot be ruled out.
 */
export const classifyCloudflareError = (error: unknown): SendResult => {
  const code = errorCode(error);
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) {
    return {
      kind: 'rejected',
      provider: 'cloudflare',
      reason: code,
      retryable: true,
    };
  }

  if (code !== undefined && PERMANENT_ERROR_CODES.has(code)) {
    return {
      kind: 'rejected',
      provider: 'cloudflare',
      reason: code,
      retryable: false,
    };
  }

  return {
    kind: 'ambiguous',
    provider: 'cloudflare',
    reason: code ?? 'binding_failure',
  };
};

export const createCloudflareEmailSender = (
  binding: CloudflareEmailBinding | undefined,
): EmailSender => ({
  capabilities: { idempotencyWindowSeconds: null },
  checkConfiguration: (): ConfigurationCheck =>
    binding === undefined
      ? {
          configured: false,
          reason: 'cloudflare_binding_missing',
        }
      : { configured: true },
  provider: 'cloudflare',
  send: async (envelope: EmailEnvelope): Promise<SendResult> => {
    if (binding === undefined) {
      return {
        kind: 'rejected',
        provider: 'cloudflare',
        reason: 'cloudflare_binding_missing',
        retryable: false,
      };
    }

    try {
      const from: EmailAddress = {
        email: envelope.from.email,
        name:
          envelope.from.name ??
          envelope.from.email.split('@')[0] ??
          'LeadScroll',
      };
      const result = await binding.send({
        from,
        html: envelope.html,
        subject: envelope.subject,
        text: envelope.text,
        to: envelope.to,
      });
      const messageId =
        typeof result?.messageId === 'string' && result.messageId.length > 0
          ? result.messageId
          : undefined;
      return {
        kind: 'accepted',
        ...(messageId === undefined ? {} : { messageId }),
        provider: 'cloudflare',
      };
    } catch (error) {
      return classifyCloudflareError(error);
    }
  },
});
