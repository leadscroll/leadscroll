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
  'binding_failure',
  'budget_exhausted',
  'canonical_origin_missing',
  'cloudflare_binding_missing',
  'concurrent_idempotent_requests',
  'config_invalid',
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
  'uncancelable_timeout',
  'unexpected_error',
  'validation_error',
]);

export type NotificationTrace = {
  readonly spanId: string;
  readonly traceId: string;
};

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
  trace?: NotificationTrace;
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
    ...(outcome.trace === undefined
      ? {}
      : { spanId: outcome.trace.spanId, traceId: outcome.trace.traceId }),
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
