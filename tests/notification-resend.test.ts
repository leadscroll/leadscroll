import { type EmailEnvelope } from '@/notifications/email';
import {
  createResendEmailSender,
  type FetchLike,
  formatResendFrom,
} from '@/notifications/providers/resend';
import { describe, expect, test, vi } from 'vitest';

const envelope: EmailEnvelope = {
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  html: '<p>Hi</p>',
  subject: 'A new lead is available in LeadScroll',
  text: 'Hi',
  to: 'staff@example.test',
};

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, {
    headers: { 'Content-Type': 'application/json', ...headers },
    status,
  });

type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

const senderWith = (fetchMock: FetchMock) =>
  createResendEmailSender('re_secret_key', fetchMock);

describe('Resend email adapter', () => {
  test('reports a missing key and never calls fetch', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ id: 'x' }));
    const sender = createResendEmailSender(undefined, fetchMock);
    expect(sender.checkConfiguration()).toEqual({
      configured: false,
      reason: 'resend_api_key_missing',
    });
    await expect(
      sender.send(envelope, { deliveryKey: 'k' }),
    ).resolves.toMatchObject({ kind: 'rejected', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends the payload to the fixed endpoint with an idempotency key', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ id: 're_1' }),
    );
    const sender = senderWith(fetchMock);

    await expect(
      sender.send(envelope, { deliveryKey: 'leadscroll-notification:abc' }),
    ).resolves.toEqual({
      kind: 'accepted',
      messageId: 're_1',
      provider: 'resend',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_secret_key');
    expect(headers['Idempotency-Key']).toBe('leadscroll-notification:abc');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'LeadScroll <notifications@example.test>',
      html: '<p>Hi</p>',
      subject: 'A new lead is available in LeadScroll',
      text: 'Hi',
      to: ['staff@example.test'],
    });
  });

  test('repeated sends with the same context reuse the exact key and body', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ id: 're_2' }),
    );
    const sender = senderWith(fetchMock);
    const context = { deliveryKey: 'leadscroll-notification:repeat' };
    await sender.send(envelope, context);
    await sender.send(envelope, context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] ?? {};
    const second = fetchMock.mock.calls[1][1] ?? {};
    expect(String(first.body)).toBe(String(second.body));
    expect((first.headers as Record<string, string>)['Idempotency-Key']).toBe(
      (second.headers as Record<string, string>)['Idempotency-Key'],
    );
  });

  test('aborts on timeout and reports the unknown outcome honestly', async () => {
    const hangingFetch = vi.fn<FetchLike>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    await expect(
      senderWith(hangingFetch).send(envelope, {
        deliveryKey: 'leadscroll-notification:timeout',
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'timeout',
    });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  test('treats malformed success and transport failures as ambiguous', async () => {
    const malformed = vi.fn<FetchLike>(async () =>
      jsonResponse({ nope: true }),
    );
    await expect(
      senderWith(malformed).send(envelope, { deliveryKey: 'k' }),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'malformed_response',
    });

    const brokenJson = vi.fn<FetchLike>(
      async () => new Response('not json', { status: 200 }),
    );
    await expect(
      senderWith(brokenJson).send(envelope, { deliveryKey: 'k' }),
    ).resolves.toMatchObject({ kind: 'ambiguous' });

    const transport = vi.fn<FetchLike>(async () => {
      throw new Error('socket closed');
    });
    await expect(
      senderWith(transport).send(envelope, { deliveryKey: 'k' }),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'transport_error',
    });
  });

  test('classifies documented HTTP errors', async () => {
    const cases: Array<[Response, Record<string, unknown>]> = [
      [
        jsonResponse({ name: 'missing_api_key' }, 401),
        { kind: 'rejected', reason: 'missing_api_key', retryable: false },
      ],
      [
        jsonResponse({ name: 'suspended_api_key' }, 403),
        { kind: 'rejected', reason: 'suspended_api_key', retryable: false },
      ],
      [
        jsonResponse({ name: 'validation_error' }, 422),
        { kind: 'rejected', reason: 'validation_error', retryable: false },
      ],
      [
        jsonResponse({ name: 'rate_limit_exceeded' }, 429, {
          'Retry-After': '30',
        }),
        {
          kind: 'rejected',
          reason: 'rate_limit_exceeded',
          retryable: true,
          retryAfterSeconds: 30,
        },
      ],
      [
        jsonResponse({ name: 'daily_quota_exceeded' }, 429),
        { kind: 'rejected', reason: 'daily_quota_exceeded', retryable: true },
      ],
      [
        jsonResponse({ name: 'concurrent_idempotent_requests' }, 409),
        {
          kind: 'rejected',
          reason: 'concurrent_idempotent_requests',
          retryable: true,
        },
      ],
      [
        jsonResponse({ name: 'invalid_idempotent_request' }, 409),
        {
          kind: 'rejected',
          reason: 'invalid_idempotent_request',
          retryable: false,
        },
      ],
      [
        jsonResponse({ name: 'application_error' }, 500),
        { kind: 'ambiguous', reason: 'application_error' },
      ],
      [
        jsonResponse({ name: 'service_unavailable' }, 503),
        { kind: 'ambiguous', reason: 'service_unavailable' },
      ],
    ];

    for (const [response, expected] of cases) {
      const fetchMock = vi.fn<FetchLike>(async () => response.clone());
      const result = await senderWith(fetchMock).send(envelope, {
        deliveryKey: 'k',
      });
      expect(result).toMatchObject({ provider: 'resend', ...expected });
    }
  });

  test('unexpected provider error text collapses to a safe reason', async () => {
    const unknownName = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { message: 'SENTINEL secret body text', name: 'SENTINEL secret name' },
        422,
      ),
    );
    await expect(
      senderWith(unknownName).send(envelope, { deliveryKey: 'k' }),
    ).resolves.toEqual({
      kind: 'rejected',
      provider: 'resend',
      reason: 'http_422',
      retryable: false,
    });

    const plainMessage = vi.fn<FetchLike>(async () =>
      jsonResponse({ message: 'SENTINEL in a message only' }, 500),
    );
    await expect(
      senderWith(plainMessage).send(envelope, { deliveryKey: 'k' }),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'http_500',
    });
  });

  test('formats the from header only when a display name exists', () => {
    expect(formatResendFrom({ email: 'a@b.c', name: 'Name' })).toBe(
      'Name <a@b.c>',
    );
    expect(formatResendFrom({ email: 'a@b.c' })).toBe('a@b.c');
  });
});
