import {
  classifyResendResult,
  formatResendFrom,
  RESEND_API_BASE_URL,
} from '@/notifications/providers/resend';
import { type CreateEmailResponse } from 'resend';
import { describe, expect, test } from 'vitest';

/**
 * The adapter's response classification is a pure function; the SDK-backed
 * send path (abort, redacted raw errors, no retry) is exercised against the
 * real SDK under mocked outbound in notification-worker-integration.test.ts.
 */
const success = (id: unknown): CreateEmailResponse =>
  ({ data: { id }, error: null, headers: {} }) as CreateEmailResponse;

const failure = (
  name: unknown,
  statusCode: unknown,
  message = 'provider detail',
): CreateEmailResponse =>
  ({
    data: null,
    error: { message, name, statusCode },
    headers: {},
  }) as CreateEmailResponse;

describe('Resend provider classification', () => {
  test('accepts a response with a message id', () => {
    expect(classifyResendResult(success('re_1'))).toEqual({
      kind: 'accepted',
      messageId: 're_1',
      provider: 'resend',
    });
  });

  test('treats a malformed success as ambiguous', () => {
    expect(classifyResendResult(success(undefined))).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'malformed_response',
    });
  });

  test('classifies documented HTTP rejections', () => {
    expect(classifyResendResult(failure('rate_limit_exceeded', 429))).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'rate_limit_exceeded',
      retryable: true,
    });
    expect(
      classifyResendResult(failure('concurrent_idempotent_requests', 409)),
    ).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'concurrent_idempotent_requests',
      retryable: true,
    });
    expect(
      classifyResendResult(failure('invalid_idempotent_request', 409)),
    ).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'invalid_idempotent_request',
      retryable: false,
    });
    expect(classifyResendResult(failure('validation_error', 422))).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'validation_error',
      retryable: false,
    });
  });

  test('treats 5xx and unreachable responses as ambiguous', () => {
    expect(classifyResendResult(failure('application_error', 500))).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'application_error',
    });
    expect(classifyResendResult(failure('service_unavailable', 503))).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'service_unavailable',
    });
    expect(
      classifyResendResult(failure('application_error', null, 'no network')),
    ).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'transport_error',
    });
  });

  test('collapses unexpected provider text to a safe status reason', () => {
    expect(
      classifyResendResult(
        failure('SENTINEL secret name', 422, 'SENTINEL body'),
      ),
    ).toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'http_422',
      retryable: false,
    });
    expect(classifyResendResult(failure('SENTINEL secret name', 500))).toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'http_500',
    });
  });

  test('uses the fixed public API host', () => {
    expect(RESEND_API_BASE_URL).toBe('https://api.resend.com');
  });

  test('formats the from header only when a display name exists', () => {
    expect(formatResendFrom({ email: 'a@b.c', name: 'Name' })).toBe(
      'Name <a@b.c>',
    );
    expect(formatResendFrom({ email: 'a@b.c' })).toBe('a@b.c');
  });
});
