/**
 * Resend HTTPS adapter.
 *
 * Uses the fixed public API host, a server-side decrypted send-only API key,
 * and the caller's namespaced `Idempotency-Key` so an accidental duplicate of
 * the same event/recipient collapses inside Resend's documented 24-hour
 * window. Requests carry a finite timeout; a timeout or transport failure is
 * ambiguous and is reported honestly without automatic retry. Error
 * classification follows the documented Resend error reference (checked
 * 2026-10-11).
 */

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type EmailEnvelope,
  type EmailSender,
  type SendContext,
  type SendResult,
} from '../email';

const RESEND_API_URL = 'https://api.resend.com/emails';
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const formatResendFrom = (from: EmailEnvelope['from']): string =>
  from.name === undefined ? from.email : `${from.name} <${from.email}>`;

const readRetryAfterSeconds = (response: Response): number | undefined => {
  const value = response.headers.get('Retry-After');
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const RESEND_ERROR_NAMES = new Set([
  'application_error',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
  'email_above_quota',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_parameter',
  'invalid_permission',
  'method_not_allowed',
  'missing_api_key',
  'missing_required_field',
  'missing_required_parameter',
  'monthly_quota_exceeded',
  'not_found',
  'rate_limit_exceeded',
  'resource_locked',
  'restricted_api_key',
  'service_unavailable',
  'suspended_api_key',
  'validation_error',
]);

/**
 * Extracts only a documented Resend error name. Unknown or unexpected values
 * collapse to `provider_error`, so an arbitrary provider string can never
 * reach D1, a UI label, or a log line.
 */
const parseResendErrorCode = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as unknown;
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (
        typeof record.name === 'string' &&
        RESEND_ERROR_NAMES.has(record.name)
      ) {
        return record.name;
      }
    }
  } catch {
    // The body is not JSON; fall back to a status-derived code.
  }

  return `http_${response.status}`;
};

/**
 * Maps a definitive HTTP rejection onto the normalized contract.
 * `409 concurrent_idempotent_requests` is safe to retry with the same key;
 * `409 invalid_idempotent_request` means the key was reused with a different
 * payload and is terminal. 5xx responses are ambiguous: they are retried only
 * inside the idempotency window, never with a new key.
 */
const classifyResendResponse = async (
  response: Response,
): Promise<SendResult> => {
  const status = response.status;
  if (status === 200 || status === 201 || status === 202) {
    let messageId: string | undefined;
    try {
      const payload = (await response.json()) as unknown;
      if (
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).id === 'string'
      ) {
        messageId = (payload as Record<string, string>).id;
      }
    } catch {
      return {
        kind: 'ambiguous',
        provider: 'resend',
        reason: 'malformed_response',
      };
    }

    if (messageId === undefined || messageId.length === 0) {
      return {
        kind: 'ambiguous',
        provider: 'resend',
        reason: 'malformed_response',
      };
    }

    return { kind: 'accepted', messageId, provider: 'resend' };
  }

  const code = await parseResendErrorCode(response);

  if (status === 429) {
    const retryAfterSeconds = readRetryAfterSeconds(response);
    return {
      kind: 'rejected',
      provider: 'resend',
      reason: code,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }

  if (status === 409) {
    if (code === 'concurrent_idempotent_requests') {
      return {
        kind: 'rejected',
        provider: 'resend',
        reason: code,
        retryable: true,
      };
    }

    return {
      kind: 'rejected',
      provider: 'resend',
      reason: code === 'provider_error' ? 'provider_error' : code,
      retryable: false,
    };
  }

  if (status === 500 || status === 503 || status === 502 || status === 504) {
    return { kind: 'ambiguous', provider: 'resend', reason: code };
  }

  // 400/401/403/404/405/422: a definitive rejection with no acceptance.
  return {
    kind: 'rejected',
    provider: 'resend',
    reason: code,
    retryable: false,
  };
};

export const createResendEmailSender = (
  apiKey: string | undefined,
  fetchImplementation: FetchLike = fetch,
): EmailSender => ({
  provider: 'resend',
  send: async (
    envelope: EmailEnvelope,
    context: SendContext,
  ): Promise<SendResult> => {
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return {
        kind: 'rejected',
        provider: 'resend',
        reason: 'resend_api_key_missing',
        retryable: false,
      };
    }

    const idempotencyKey = context.deliveryKey.slice(
      0,
      MAX_IDEMPOTENCY_KEY_LENGTH,
    );
    const signal = AbortSignal.timeout(
      context.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetchImplementation(RESEND_API_URL, {
        body: JSON.stringify({
          from: formatResendFrom(envelope.from),
          html: envelope.html,
          subject: envelope.subject,
          text: envelope.text,
          to: [envelope.to],
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        method: 'POST',
        signal,
      });
    } catch {
      // A timeout means acceptance is unknown and the request was aborted. A
      // transport failure leaves acceptance unknown too; neither is retried
      // automatically.
      return {
        kind: 'ambiguous',
        provider: 'resend',
        reason: signal.aborted ? 'timeout' : 'transport_error',
      };
    }

    return classifyResendResponse(response);
  },
});
