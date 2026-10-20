/**
 * HTTP API error contract.
 *
 * Domain and platform failures are mapped to one shared error shape at the
 * boundary: `{ code, message, details? }`. Each HTTP status has its own
 * `Schema.TaggedError` class so `HttpApi` can select the correct response
 * status and the generated client can decode a typed error. The `_tag` is the
 * reason; there is no separate reason field or hand-maintained schema union.
 */

import { type DomainError, type PersistenceError } from '@/application/errors';
import { Data, Schema } from 'effect';

// Lowercase alias keeps the schema-class expression readable to ESLint's
// `new-cap` rule; `Schema.TaggedError` is a factory, not a constructor.
const taggedError = Schema.TaggedError;

/**
 * Domain codes that map to a non-422 status; everything else is 422.
 */
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  // A corrupt installation configuration fails closed and is never echoed or
  // silently reset; the operator restores it out of band.
  config_unavailable: 500,
  conflict: 409,
  not_found: 404,
  revision_conflict: 409,
  scope_conflict: 409,
  scope_exists: 409,
  tag_exists: 409,
  test_daily_limited: 429,
  test_rate_limited: 429,
  test_request_conflict: 409,
};

export const domainErrorStatus = (code: string): number =>
  DOMAIN_ERROR_STATUS[code] ?? 422;

export const ApiErrorFields = {
  code: Schema.String,
  details: Schema.optional(Schema.Unknown),
  message: Schema.String,
};

export class ApiBadRequestError extends taggedError<ApiBadRequestError>()(
  'ApiBadRequestError',
  ApiErrorFields,
  { httpApiStatus: 400 },
) {}

export class ApiConflictError extends taggedError<ApiConflictError>()(
  'ApiConflictError',
  ApiErrorFields,
  { httpApiStatus: 409 },
) {}

export class ApiForbiddenError extends taggedError<ApiForbiddenError>()(
  'ApiForbiddenError',
  ApiErrorFields,
  { httpApiStatus: 403 },
) {}

export class ApiInternalError extends taggedError<ApiInternalError>()(
  'ApiInternalError',
  ApiErrorFields,
  { httpApiStatus: 500 },
) {}

export class ApiNotFoundError extends taggedError<ApiNotFoundError>()(
  'ApiNotFoundError',
  ApiErrorFields,
  { httpApiStatus: 404 },
) {}

export class ApiPayloadTooLargeError extends taggedError<ApiPayloadTooLargeError>()(
  'ApiPayloadTooLargeError',
  ApiErrorFields,
  { httpApiStatus: 413 },
) {}

export class ApiRateLimitError extends taggedError<ApiRateLimitError>()(
  'ApiRateLimitError',
  ApiErrorFields,
  { httpApiStatus: 429 },
) {}

export class ApiServiceUnavailableError extends taggedError<ApiServiceUnavailableError>()(
  'ApiServiceUnavailableError',
  ApiErrorFields,
  { httpApiStatus: 503 },
) {}

export class ApiUnauthorizedError extends taggedError<ApiUnauthorizedError>()(
  'ApiUnauthorizedError',
  ApiErrorFields,
  { httpApiStatus: 401 },
) {}

export class ApiUnsupportedMediaTypeError extends taggedError<ApiUnsupportedMediaTypeError>()(
  'ApiUnsupportedMediaTypeError',
  ApiErrorFields,
  { httpApiStatus: 415 },
) {}

export class ApiValidationError extends taggedError<ApiValidationError>()(
  'ApiValidationError',
  ApiErrorFields,
  { httpApiStatus: 422 },
) {}

/**
 * Internal transport/guard failure. It carries the intended status so the
 * boundary mapper can choose one of the public status-specific classes.
 */
export class PlatformError extends Data.TaggedError('PlatformError')<{
  code: string;
  details?: unknown;
  message: string;
  status: number;
}> {}

const errorForStatus = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => {
  switch (status) {
    case 400:
      return new ApiBadRequestError({ code, details, message });
    case 401:
      return new ApiUnauthorizedError({ code, details, message });
    case 403:
      return new ApiForbiddenError({ code, details, message });
    case 404:
      return new ApiNotFoundError({ code, details, message });
    case 409:
      return new ApiConflictError({ code, details, message });
    case 413:
      return new ApiPayloadTooLargeError({ code, details, message });
    case 415:
      return new ApiUnsupportedMediaTypeError({ code, details, message });
    case 429:
      return new ApiRateLimitError({ code, details, message });
    case 500:
      return new ApiInternalError({ code, details, message });
    case 503:
      return new ApiServiceUnavailableError({ code, details, message });
    default:
      return new ApiValidationError({ code, details, message });
  }
};

/**
 * Maps an internal failure to exactly one public HTTP API error.
 */
export const toApiError = (
  error: DomainError | PersistenceError | PlatformError,
) => {
  if (error._tag === 'PlatformError') {
    return errorForStatus(
      error.status,
      error.code,
      error.message,
      error.details,
    );
  }

  if (error._tag === 'DomainError') {
    return errorForStatus(
      domainErrorStatus(error.code),
      error.code,
      error.message,
      error.details,
    );
  }

  return new ApiInternalError({
    code: 'persistence_error',
    message: 'The request could not be persisted.',
  });
};

/**
 * Errors used by every authenticated staff endpoint.
 */
export const StaffApiErrors = [
  ApiBadRequestError,
  ApiUnauthorizedError,
  ApiForbiddenError,
  ApiNotFoundError,
  ApiConflictError,
  ApiPayloadTooLargeError,
  ApiUnsupportedMediaTypeError,
  ApiValidationError,
  ApiRateLimitError,
  ApiInternalError,
  ApiServiceUnavailableError,
] as const;

/**
 * Errors the staff authentication middleware can produce.
 */
export const StaffAuthErrors = [
  ApiUnauthorizedError,
  ApiForbiddenError,
  ApiUnsupportedMediaTypeError,
  ApiServiceUnavailableError,
  ApiInternalError,
] as const;

/**
 * Errors used by the public/authenticated intake endpoints.
 */
export const IntakeApiErrors = [
  ApiBadRequestError,
  ApiUnauthorizedError,
  ApiPayloadTooLargeError,
  ApiUnsupportedMediaTypeError,
  ApiConflictError,
  ApiValidationError,
  ApiInternalError,
] as const;
