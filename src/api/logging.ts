/**
 * Structured request logging for the LeadScroll API.
 *
 * Emits one JSON line per API request. Lines are emitted synchronously
 * before the response is returned: a Workers isolate may be suspended as
 * soon as the response is sent, so post-response callbacks (including
 * Elysia's `onAfterResponse` hook) are not a reliable place to log.
 *
 * Levels: 5xx statuses and logged failures use `console.error`, everything
 * else uses `console.log`.
 *
 * Privacy: lines carry only the method, the URL pathname (never the query
 * string — e.g. `/v1/contacts?query=` search terms are contact data), the
 * final status, the duration, and for failures the error class (plus the
 * error message for command defects). The browser token segment of
 * `/v1/public/intakes/:token` is redacted before logging. Never headers,
 * bodies, tokens, query strings, stacks, or SQL with bound values:
 * persistence failures log the cause's class only, because a database error
 * message can embed SQL with bound values.
 */

const requestStarts = new WeakMap<object, number>();

// Browser intake tokens travel in the pathname. They are intentionally public
// and write-only, but the logger's contract is that no token reaches a line —
// which also keeps an API token pasted into the wrong URL out of the logs.
const PUBLIC_INTAKE_TOKEN_PATH = /^\/v1\/public\/intakes\/.+$/u;

const redactPath = (pathname: string): string =>
  PUBLIC_INTAKE_TOKEN_PATH.test(pathname)
    ? '/v1/public/intakes/:token'
    : pathname;

const roundMs = (value: number): number => Math.round(value * 100) / 100;

/**
 * Record the start time for a request. Called once per request at the API boundary.
 */
export const markRequestStart = (request: Request): void => {
  requestStarts.set(request, performance.now());
};

const durationMs = (request: Request): number => {
  const started = requestStarts.get(request);
  return started === undefined
    ? 0
    : Math.max(0, roundMs(performance.now() - started));
};

type FailureFields = {
  errorCauseClass?: string;
  errorClass: string;
  errorMessage?: string;
};

/**
 * Emit one structured JSON line for the request.
 *
 * `status` must be the final HTTP status of the response. When `failure` is
 * provided the line is a failure line (`event: "request.failure"`) carrying
 * the error class/message instead of relying on the status alone; it is
 * still emitted at the level chosen by `status`.
 */
export const logRequest = (
  request: Request,
  status: number,
  failure?: FailureFields,
): void => {
  const line = JSON.stringify({
    durationMs: durationMs(request),
    event: failure ? 'request.failure' : 'request',
    method: request.method,
    path: redactPath(new URL(request.url).pathname),
    status,
    ...failure,
  });
  if (status >= 500) {
    console.error(line);
  } else {
    console.log(line);
  }
};

/**
 * Allowlisted notification reasons safe to log. These are application reason
 * codes and documented provider error names; anything else is reduced to
 * `unclassified` so an unexpected provider object can never inject text (or
 * an address/payload fragment) into a log line.
 */
const SAFE_NOTIFICATION_REASONS = new Set([
  'account_disabled',
  'ack_failed',
  'address_changed',
  'ambiguous',
  'ambiguous_account_disabled',
  'ambiguous_address_changed',
  'ambiguous_exhausted',
  'ambiguous_lead_closed',
  'ambiguous_lease',
  'ambiguous_unsubscribed',
  'application_error',
  'binding_failure',
  'cloudflare_binding_missing',
  'concurrent_idempotent_requests',
  'config_changed',
  'daily_quota_exceeded',
  'decrypt_failed',
  'disabled',
  'E_CONTENT_TOO_LARGE',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_FIELD_MISSING',
  'E_HEADER_NAME_INVALID',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
  'E_INTERNAL_SERVER_ERROR',
  'E_RATE_LIMIT_EXCEEDED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_SENDER_NOT_VERIFIED',
  'E_TOO_MANY_RECIPIENTS',
  'E_VALIDATION_ERROR',
  'email_above_quota',
  'encryption_key_invalid',
  'encryption_key_missing',
  'expired',
  'expired_ambiguous',
  'frozen_payload_invalid',
  'idempotency_deadline_passed',
  'invalid_api_key',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_parameter',
  'invalid_permission',
  'lead_closed',
  'lease_expired',
  'malformed_response',
  'method_not_allowed',
  'missing_api_key',
  'missing_required_field',
  'missing_required_parameter',
  'monthly_quota_exceeded',
  'not_found',
  'provider_error',
  'provider_unavailable',
  'quota_or_rate_limited',
  'rate_limit_exceeded',
  'resend_api_key_missing',
  'resource_locked',
  'restricted_api_key',
  'retry_exhausted',
  'service_unavailable',
  'suspended_api_key',
  'transport_error',
  'unexpected',
  'unexpected_error',
  'unresolved_after_rejection',
  'unsubscribed',
  'validation_error',
]);

const safeNotificationReason = (reasonCode: null | string): null | string => {
  if (reasonCode === null) {
    return null;
  }

  return SAFE_NOTIFICATION_REASONS.has(reasonCode)
    ? reasonCode
    : 'unclassified';
};

type NotificationOutcomeFields = {
  attempt?: number;
  kind: string;
  outboxId?: string;
  reasonCode?: null | string;
};

/**
 * Emit one bounded structured line per notification outcome. The line carries
 * only the opaque outbox id, the outcome, the attempt count, and an
 * allowlisted reason; never an address, envelope, provider body, or lead
 * payload.
 */
export const logNotificationDispatchOutcome = (
  outcome: NotificationOutcomeFields,
): void => {
  const reason = safeNotificationReason(outcome.reasonCode ?? null);
  console.log(
    JSON.stringify({
      event: 'notification.dispatch',
      ...(outcome.attempt === undefined ? {} : { attempt: outcome.attempt }),
      ...(outcome.outboxId === undefined ? {} : { outboxId: outcome.outboxId }),
      outcome: outcome.kind,
      ...(reason === null ? {} : { reason }),
    }),
  );
};
