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
 * Allowlisted notification event reasons safe to log. These are application
 * reason codes and documented provider error names; anything else is reduced
 * to `unclassified`, and a status-derived HTTP class (`http_422`) is allowed,
 * so an unexpected provider object can never inject text (or an address or
 * payload fragment) into a log line.
 */
const SAFE_NOTIFICATION_REASONS = new Set([
  // Documented Resend error names.
  'application_error',
  'budget_exhausted',
  'canonical_origin_missing',
  'cloudflare_binding_missing',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
  'decrypt_failed',
  'disabled',
  // Documented Cloudflare Email Sending error identifiers.
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
  'from_email_missing',
  'invalid_api_key',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_parameter',
  'invalid_permission',
  'lead_missing',
  'malformed_response',
  'method_not_allowed',
  'missing_api_key',
  'missing_required_field',
  'missing_required_parameter',
  'monthly_quota_exceeded',
  'no_recipients',
  'not_configured',
  'not_found',
  'provider_error',
  'rate_limit_exceeded',
  'resend_api_key_missing',
  'resource_locked',
  'restricted_api_key',
  'service_unavailable',
  'suspended_api_key',
  'timeout',
  'transport_error',
  'unexpected_error',
  'validation_error',
]);

const safeNotificationReason = (reasonCode: null | string): null | string => {
  if (reasonCode === null) {
    return null;
  }

  if (SAFE_NOTIFICATION_REASONS.has(reasonCode)) {
    return reasonCode;
  }

  return /^http_[1-5]\d{2}$/u.test(reasonCode) ? reasonCode : 'unclassified';
};

/**
 * One bounded structured line per best-effort notification event. The line
 * carries the event kind, the opaque lead id, the outcome, recipient counts,
 * the selected provider, and an allowlisted reason; never an address,
 * envelope, provider body, or lead payload.
 */
export type NotificationEventOutcome = {
  accepted?: number;
  errorClass?: string;
  eventKind: 'lead.created';
  failed?: number;
  leadId: string;
  outcome:
    | 'delivered'
    | 'failed'
    | 'scheduling_failed'
    | 'skipped'
    | 'subscriber_failed';
  provider?: 'cloudflare' | 'resend';
  reasonCode?: null | string;
  recipients?: number;
  skipped?: number;
};

export const logNotificationEventOutcome = (
  outcome: NotificationEventOutcome,
): void => {
  const reason = safeNotificationReason(outcome.reasonCode ?? null);
  const line = JSON.stringify({
    event: 'notification.event',
    eventKind: outcome.eventKind,
    leadId: outcome.leadId,
    outcome: outcome.outcome,
    ...(outcome.provider === undefined ? {} : { provider: outcome.provider }),
    ...(outcome.recipients === undefined
      ? {}
      : { recipients: outcome.recipients }),
    ...(outcome.accepted === undefined ? {} : { accepted: outcome.accepted }),
    ...(outcome.failed === undefined ? {} : { failed: outcome.failed }),
    ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
    ...(reason === null ? {} : { reason }),
    ...(outcome.errorClass === undefined
      ? {}
      : { errorClass: outcome.errorClass }),
  });
  if (
    outcome.outcome === 'failed' ||
    outcome.outcome === 'scheduling_failed' ||
    outcome.outcome === 'subscriber_failed'
  ) {
    console.error(line);
  } else {
    console.log(line);
  }
};
