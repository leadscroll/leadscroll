/**
 * Provider-agnostic email transport contract.
 *
 * Business code depends only on this module; the Cloudflare and Resend
 * adapters implement it under ./providers. A result is always one of three
 * normalized outcomes:
 *
 * - accepted: the provider returned a positive acknowledgement. A message id
 *   is evidence of submission, not inbox delivery.
 * - rejected: a definite non-acceptance (validation, configuration, quota,
 *   suppression). `retryable` describes the provider's own guidance; the
 *   best-effort event subscriber does not automatically retry.
 * - ambiguous: acceptance is unknown (transport failure, timeout, malformed
 *   success, provider 5xx). The caller reports it honestly and never switches
 *   providers.
 *
 * Every send is bounded by a finite timeout. The default applies when the
 * caller does not pass one in the send context; the subscriber tightens it to
 * the remaining background budget so one slow provider cannot outlive the
 * Worker's runtime window.
 */

export type ConfigurationCheck =
  { configured: false; reason: string } | { configured: true };

export type EmailAddress = {
  email: string;
  name?: string;
};

export type EmailEnvelope = {
  from: EmailAddress;
  html: string;
  subject: string;
  text: string;
  to: string;
};

export type EmailProvider = 'cloudflare' | 'resend';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

export type EmailSender = {
  checkConfiguration: () => ConfigurationCheck;
  provider: EmailProvider;
  send: (envelope: EmailEnvelope, context: SendContext) => Promise<SendResult>;
};

export type SendContext = {
  /**
   * Namespaced key scoped to one event/recipient (or one explicit test). It
   * only exists so a provider with request-level idempotency can collapse an
   * accidental duplicate of the same message; best-effort delivery does not
   * retry.
   */
  deliveryKey: string;
  /**
   * Finite timeout for this call. Defaults to DEFAULT_PROVIDER_TIMEOUT_MS.
   */
  timeoutMs?: number;
};

export type SendResult =
  | { kind: 'accepted'; messageId?: string; provider: EmailProvider }
  | { kind: 'ambiguous'; provider?: EmailProvider; reason: string }
  | {
      kind: 'rejected';
      provider?: EmailProvider;
      reason: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    };

/**
 * Stable duplicate-collapse key for one new-lead recipient. The key is not
 * durable state: it is derived from the committed event and recipient so two
 * accidental deliveries of the same event share a provider idempotency key.
 */
export const leadDeliveryKey = (leadId: string, userId: string): string =>
  `leadscroll-notification:${leadId}:${userId}`;

export const testDeliveryKeyFor = (requestId: string): string =>
  `leadscroll-email-test:${requestId}`;
