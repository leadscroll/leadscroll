/**
 * Provider-agnostic email transport contract.
 *
 * Business code (outbox, delivery, settings) depends only on this module; the
 * Cloudflare and Resend adapters implement it under ./providers. A result is
 * always one of three normalized outcomes:
 *
 * - accepted: the provider returned a positive acknowledgement. A message id
 *   is evidence of submission, not inbox delivery.
 * - rejected: a definite non-acceptance (validation, configuration, quota,
 *   suppression). `retryable` distinguishes transient rate/quota rejections
 *   from permanent failures.
 * - ambiguous: acceptance is unknown (transport failure, timeout, malformed
 *   success, provider 5xx). Callers apply the provider-specific recovery
 *   policy; they never switch providers or fabricate a new idempotency key.
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

export type EmailSender = {
  capabilities: {
    /**
     * Length of the provider's idempotency-key window in seconds, or null when
     * the provider has no documented request-level idempotency.
     */
    idempotencyWindowSeconds: null | number;
  };
  checkConfiguration: () => ConfigurationCheck;
  provider: EmailProvider;
  send: (
    envelope: EmailEnvelope,
    context: { deliveryKey: string },
  ) => Promise<SendResult>;
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
 * Deterministic wire serialization for a frozen envelope. Object-key order is
 * fixed by construction, so the same envelope always produces the same JSON
 * and hash across retries and deployments.
 */
export const serializeEnvelope = (envelope: EmailEnvelope): string =>
  JSON.stringify({
    from: {
      email: envelope.from.email,
      ...(envelope.from.name === undefined ? {} : { name: envelope.from.name }),
    },
    html: envelope.html,
    subject: envelope.subject,
    text: envelope.text,
    to: envelope.to,
  });

const asRecord = (value: unknown): null | Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Parses a persisted frozen envelope. Anything malformed returns null so the
 * delivery command can fail closed instead of sending an unintended message.
 */
export const parseEnvelope = (json: string): EmailEnvelope | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const from = record === null ? null : asRecord(record.from);
  if (
    record === null ||
    from === null ||
    typeof from.email !== 'string' ||
    (from.name !== undefined && typeof from.name !== 'string') ||
    typeof record.to !== 'string' ||
    typeof record.subject !== 'string' ||
    typeof record.html !== 'string' ||
    typeof record.text !== 'string'
  ) {
    return null;
  }

  return {
    from: {
      email: from.email,
      ...(typeof from.name === 'string' ? { name: from.name } : {}),
    },
    html: record.html,
    subject: record.subject,
    text: record.text,
    to: record.to,
  };
};

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/**
 * SHA-256 of the frozen wire payload; used for integrity and conflict checks.
 */
export const envelopePayloadHash = async (
  envelope: EmailEnvelope,
): Promise<string> =>
  toHex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serializeEnvelope(envelope)),
    ),
  );

/**
 * Namespaced idempotency key for a durable outbox row. The outbox id is
 * stable, unique per recipient, and never reused, so the key is identical on
 * every retry while remaining distinguishable from other installations' keys
 * at a shared provider account.
 */
export const deliveryKeyFor = (outboxId: string): string =>
  `leadscroll-notification:${outboxId}`;

export const testDeliveryKeyFor = (requestId: string): string =>
  `leadscroll-email-test:${requestId}`;

/**
 * Two frozen attempts may only be retried together when they reference the
 * exact same provider, delivery key, and payload hash.
 */
export type FrozenAttempt = {
  configRevision: number;
  deliveryKey: string;
  envelope: EmailEnvelope;
  payloadHash: string;
  provider: EmailProvider;
};
