/**
 * Resend adapter backed by the official `resend` SDK (pinned 6.33.0).
 *
 * The SDK owns request construction, the fixed public API host, provider
 * parsing, and the `Idempotency-Key` header. This adapter stays small: it
 * normalizes SDK responses into the app contract, maps provider error names
 * through an allowlist (raw messages never leave this module), passes an
 * Effect-managed `AbortSignal` so an interrupted/timeout call aborts the HTTP
 * request, and never retries.
 *
 * Raw-error logging: the pinned SDK logs raw API errors with `console.error`
 * when `process.env.NODE_ENV !== 'production'`. Worker builds fold that
 * expression to production (Wrangler deployment defaults and the explicit
 * source-build define); the local dev scripts use the same setting. This
 * makes the logger inert without global runtime mutation.
 */

import { type EmailEnvelope, type SendResult } from '../email';
import { type EmailProviderService } from '../email-provider';
import { Cause, Duration, Effect, Option, Schema } from 'effect';
import { type CreateEmailResponse, type ErrorResponse, Resend } from 'resend';

/**
 * Fixed public host. Production composition never overrides it; tests may
 * point the SDK at a local mock server.
 */
export const RESEND_API_BASE_URL = 'https://api.resend.com';

/**
 * Documented Resend error names; anything else collapses to a status code.
 */
const RESEND_ERROR_NAMES = new Set([
  'application_error',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
  'email_above_quota',
  'invalid_access',
  'invalid_api_key',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_parameter',
  'invalid_permission',
  'invalid_region',
  'method_not_allowed',
  'missing_api_key',
  'missing_required_field',
  'missing_required_parameter',
  'monthly_quota_exceeded',
  'not_found',
  'rate_limit_exceeded',
  'resource_locked',
  'restricted_api_key',
  'security_error',
  'service_unavailable',
  'suspended_api_key',
  'validation_error',
]);

export const formatResendFrom = (from: EmailEnvelope['from']): string =>
  from.name === undefined ? from.email : `${from.name} <${from.email}>`;

const decodeAcceptedResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  }),
);

const safeErrorName = (error: ErrorResponse): string | undefined =>
  typeof error.name === 'string' && RESEND_ERROR_NAMES.has(error.name)
    ? error.name
    : undefined;

const statusReason = (
  error: ErrorResponse,
  name: string | undefined,
): string => {
  if (name !== undefined) {
    return name;
  }

  return typeof error.statusCode === 'number'
    ? `http_${error.statusCode}`
    : 'provider_error';
};

/**
 * Maps an SDK response onto the normalized contract. A null status code means
 * the SDK could not reach the API (including an aborted request), which never
 * proves non-acceptance and is therefore ambiguous.
 */
export const classifyResendResult = (
  response: CreateEmailResponse,
): SendResult => {
  if (response.error === null) {
    const accepted = decodeAcceptedResponse(response.data);
    if (Option.isSome(accepted)) {
      return {
        kind: 'accepted',
        messageId: accepted.value.id,
        provider: 'resend',
      };
    }

    return {
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'malformed_response',
    };
  }

  const error: ErrorResponse = response.error;
  const status = typeof error.statusCode === 'number' ? error.statusCode : null;
  const name = safeErrorName(error);
  if (status === null) {
    return {
      kind: 'ambiguous',
      provider: 'resend',
      reason:
        name === 'application_error'
          ? 'transport_error'
          : statusReason(error, name),
    };
  }

  const reason = statusReason(error, name);
  if (status === 429) {
    return { kind: 'rejected', provider: 'resend', reason, retryable: true };
  }

  if (status === 409) {
    return {
      kind: 'rejected',
      provider: 'resend',
      reason,
      retryable: name === 'concurrent_idempotent_requests',
    };
  }

  if (status >= 500) {
    return { kind: 'ambiguous', provider: 'resend', reason };
  }

  return { kind: 'rejected', provider: 'resend', reason, retryable: false };
};

export type ResendProviderOptions = {
  /**
   * Test-only local mock endpoint; production uses the fixed public host.
   */
  readonly baseUrl?: string;
};

export const createResendEmailProvider = (
  apiKey: string,
  options: ResendProviderOptions = {},
): EmailProviderService => {
  const client = new Resend(apiKey, {
    baseUrl: options.baseUrl ?? RESEND_API_BASE_URL,
  });

  return {
    kind: 'resend',
    // The SDK request is aborted when the Effect is interrupted or timed out.
    policy: { timeoutIsUncancelable: false },
    send: ({ deliveryKey, envelope, timeoutMs }) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: (signal) =>
          client.emails.send(
            {
              from: formatResendFrom(envelope.from),
              html: envelope.html,
              subject: envelope.subject,
              text: envelope.text,
              to: [envelope.to],
            },
            { idempotencyKey: deliveryKey, signal },
          ),
      }).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.map((response) => classifyResendResult(response)),
        Effect.catchAll((error) =>
          Effect.succeed<SendResult>(
            Cause.isTimeoutException(error)
              ? {
                  kind: 'ambiguous',
                  provider: 'resend',
                  reason: 'timeout',
                }
              : {
                  kind: 'ambiguous',
                  provider: 'resend',
                  reason: 'transport_error',
                },
          ),
        ),
      ),
  };
};
