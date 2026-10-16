import { type EmailEnvelope } from '@/notifications/email';
import {
  classifyCloudflareError,
  type CloudflareEmailBinding,
  createCloudflareEmailProvider,
} from '@/notifications/providers/cloudflare';
import { Effect } from 'effect';
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
): CloudflareEmailBinding => ({ send }) as unknown as CloudflareEmailBinding;

const envelope: EmailEnvelope = {
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  html: '<p>Hi</p>',
  subject: 'A new lead is available in LeadScroll',
  text: 'Hi',
  to: 'staff@example.test',
};

const bindingError = (code: string): Error =>
  Object.assign(new Error('provider detail'), { code });

const runSend = (provider: ReturnType<typeof createCloudflareEmailProvider>) =>
  Effect.runPromise(
    provider.send({
      deliveryKey: 'leadscroll-notification:1',
      envelope,
      timeoutMs: 1_000,
    }),
  );

describe('Cloudflare email provider', () => {
  test('maps the structured binding call, accepts a message id, and reports an uncancelable policy', async () => {
    const sent: SendBuilder[] = [];
    const bindingSend = vi.fn(async (message: SendBuilder) => {
      sent.push(message);
      return { messageId: 'cf-message-1' };
    });
    const provider = createCloudflareEmailProvider(bindingWith(bindingSend));

    expect(provider.kind).toBe('cloudflare');
    expect(provider.policy).toEqual({ timeoutIsUncancelable: true });
    await expect(runSend(provider)).resolves.toEqual({
      kind: 'accepted',
      messageId: 'cf-message-1',
      provider: 'cloudflare',
    });

    expect(sent[0]).toMatchObject({
      from: { email: 'notifications@example.test', name: 'LeadScroll' },
      html: '<p>Hi</p>',
      subject: 'A new lead is available in LeadScroll',
      text: 'Hi',
      to: 'staff@example.test',
    });
  });

  test('falls back to the local part when no display name is set', async () => {
    const sent: SendBuilder[] = [];
    const bindingSend = vi.fn(async (message: SendBuilder) => {
      sent.push(message);
      return { messageId: 'cf-message-2' };
    });
    const provider = createCloudflareEmailProvider(bindingWith(bindingSend));
    await Effect.runPromise(
      provider.send({
        deliveryKey: 'k',
        envelope: {
          ...envelope,
          from: { email: 'notifications@example.test' },
        },
        timeoutMs: 1_000,
      }),
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
    const provider = createCloudflareEmailProvider(
      bindingWith(async () => {
        throw bindingError('E_DELIVERY_FAILED');
      }),
    );
    await expect(runSend(provider)).resolves.toEqual({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_DELIVERY_FAILED',
      retryable: true,
    });
  });

  test('a binding that never resolves times out honestly without retry', async () => {
    const bindingSend = vi.fn(
      () => new Promise<{ messageId: string }>(() => {}),
    );
    const provider = createCloudflareEmailProvider(bindingWith(bindingSend));
    await expect(
      Effect.runPromise(
        provider.send({
          deliveryKey: 'leadscroll-notification:timeout',
          envelope,
          timeoutMs: 20,
        }),
      ),
    ).resolves.toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'timeout',
    });
    expect(bindingSend).toHaveBeenCalledTimes(1);
  });
});
