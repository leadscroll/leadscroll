/**
 * Resend HTTPS adapter.
 *
 * Uses the fixed public API host, a server-side decrypted send-only API key,
 * and a namespaced `Idempotency-Key` derived from the durable outbox id. The
 * adapter never regenerates the key or payload: retries of an ambiguous call
 * must repeat the exact request so Resend's 24-hour idempotency window can
 * collapse duplicates. Error classification follows the documented Resend
 * error reference (checked 2026-10-11).
 */

import {
  type ConfigurationCheck,
  type EmailEnvelope,
  type EmailSender,
  type SendResult,
} from '../email';

const RESEND_API_URL = 'https://api.resend.com/emails';
const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
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

const parseResendErrorCode = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as unknown;
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      if (typeof record.name === 'string' && record.name.length > 0) {
        return record.name;
      }

      if (typeof record.message === 'string' && record.message.length > 0) {
        return 'provider_error';
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
      reason: code === 'provider_error' ? 'quota_or_rate_limited' : code,
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
      reason: code === 'provider_error' ? 'idempotency_conflict' : code,
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
  capabilities: { idempotencyWindowSeconds: IDEMPOTENCY_WINDOW_SECONDS },
  checkConfiguration: (): ConfigurationCheck =>
    apiKey === undefined || apiKey.trim().length === 0
      ? { configured: false, reason: 'resend_api_key_missing' }
      : { configured: true },
  provider: 'resend',
  send: async (
    envelope: EmailEnvelope,
    context: { deliveryKey: string },
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
      });
    } catch {
      // A transport failure leaves acceptance unknown; the caller may repeat
      // the identical keyed request inside the idempotency window.
      return {
        kind: 'ambiguous',
        provider: 'resend',
        reason: 'transport_error',
      };
    }

    return classifyResendResponse(response);
  },
});
