import { type Env } from '@/db/repository';
import { type EmailEnvelope } from '@/notifications/email';
import {
  classifyCloudflareError,
  createCloudflareEmailSender,
} from '@/notifications/providers/cloudflare';
import { describe, expect, test, vi } from 'vitest';

type SendBuilder = {
  from: string | { email: string; name: string };
  html?: string;
  subject: string;
  text?: string;
  to: unknown;
};

const bindingWith = (
  send: (message: SendBuilder) => Promise<{ messageId: string }>,
): NonNullable<Env['EMAIL']> =>
  ({ send }) as unknown as NonNullable<Env['EMAIL']>;

const envelope: EmailEnvelope = {
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  html: '<p>Hi</p>',
  subject: 'A new lead is available in LeadScroll',
  text: 'Hi',
  to: 'staff@example.test',
};

const bindingError = (code: string): Error =>
  Object.assign(new Error('provider detail'), { code });

describe('Cloudflare email adapter', () => {
  test('isolates a missing binding to Cloudflare mode', async () => {
    const sender = createCloudflareEmailSender(undefined);
    expect(sender.provider).toBe('cloudflare');
    expect(sender.checkConfiguration()).toEqual({
      configured: false,
      reason: 'cloudflare_binding_missing',
    });
    await expect(
      sender.send(envelope, { deliveryKey: 'leadscroll-notification:1' }),
    ).resolves.toEqual({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'cloudflare_binding_missing',
      retryable: false,
    });
  });

  test('maps the structured binding call and accepts a message id', async () => {
    const sent: SendBuilder[] = [];
    const send = vi.fn(async (message: SendBuilder) => {
      sent.push(message);
      return { messageId: 'cf-message-1' };
    });
    const sender = createCloudflareEmailSender(bindingWith(send));
    expect(sender.checkConfiguration()).toEqual({ configured: true });
    await expect(
      sender.send(envelope, { deliveryKey: 'ignored-for-cloudflare' }),
    ).resolves.toEqual({
      kind: 'accepted',
      messageId: 'cf-message-1',
      provider: 'cloudflare',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const wire = sent[0];
    expect(wire).toMatchObject({
      from: { email: 'notifications@example.test', name: 'LeadScroll' },
      html: '<p>Hi</p>',
      subject: 'A new lead is available in LeadScroll',
      text: 'Hi',
      to: 'staff@example.test',
    });
  });

  test('falls back to the local part when no display name is set', async () => {
    const sent: SendBuilder[] = [];
    const send = vi.fn(async (message: SendBuilder) => {
      sent.push(message);
      return { messageId: 'cf-message-2' };
    });
    const sender = createCloudflareEmailSender(bindingWith(send));
    await sender.send(
      { ...envelope, from: { email: 'notifications@example.test' } },
      { deliveryKey: 'leadscroll-notification:2' },
    );
    expect(sent[0].from).toEqual({
      email: 'notifications@example.test',
      name: 'notifications',
    });
  });

  test('normalizes documented errors without cross-provider fallback', () => {
    expect(
      classifyCloudflareError(bindingError('E_RATE_LIMIT_EXCEEDED')),
    ).toEqual({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_RATE_LIMIT_EXCEEDED',
      retryable: true,
    });
    expect(
      classifyCloudflareError(bindingError('E_SENDER_NOT_VERIFIED')),
    ).toEqual({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_SENDER_NOT_VERIFIED',
      retryable: false,
    });
    // A binding internal error cannot prove non-acceptance.
    expect(
      classifyCloudflareError(bindingError('E_INTERNAL_SERVER_ERROR')),
    ).toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'E_INTERNAL_SERVER_ERROR',
    });
    expect(classifyCloudflareError(bindingError('E_SOMETHING_NEW'))).toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'E_SOMETHING_NEW',
    });
    expect(classifyCloudflareError(new Error('no code'))).toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'binding_failure',
    });
  });

  test('a throwing binding never becomes accepted or retried elsewhere', async () => {
    const sender = createCloudflareEmailSender(
      bindingWith(async () => {
        throw bindingError('E_DELIVERY_FAILED');
      }),
    );
    await expect(
      sender.send(envelope, { deliveryKey: 'leadscroll-notification:3' }),
    ).resolves.toEqual({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_DELIVERY_FAILED',
      retryable: true,
    });
  });

  test('a binding that never resolves times out honestly without retry', async () => {
    const send = vi.fn(() => new Promise<{ messageId: string }>(() => {}));
    const sender = createCloudflareEmailSender(bindingWith(send));
    await expect(
      sender.send(envelope, {
        deliveryKey: 'leadscroll-notification:timeout',
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'timeout',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
