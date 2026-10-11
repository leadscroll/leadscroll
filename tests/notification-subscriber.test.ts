import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { type Env } from '@/db/repository';
import {
  type EmailEnvelope,
  type EmailSender,
  type SendContext,
  type SendResult,
} from '@/notifications/email';
import {
  createLeadCreatedEmailSubscriber,
  NOTIFICATION_BUDGET_MS,
  NOTIFICATION_PROVIDER_TIMEOUT_MS,
} from '@/notifications/lead-created-subscriber';
import { createCloudflareEmailSender } from '@/notifications/providers/cloudflare';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR_ID = 'creator-user';

let fixture: NotificationFixture;

beforeEach(async () => {
  if (fixture !== undefined) {
    await fixture.dispose();
  }

  // The hook runs serially; the rule cannot see that.
  // eslint-disable-next-line require-atomic-updates
  fixture = await startNotificationFixture();
});

afterEach(async () => {
  await fixture.dispose();
  vi.restoreAllMocks();
});

type SentMessage = { context: SendContext; envelope: EmailEnvelope };

const recordingSender = (
  result?: ((call: number) => SendResult) | SendResult,
) => {
  const resolvedResult: ((call: number) => SendResult) | SendResult =
    result ?? { kind: 'accepted', provider: 'cloudflare' };
  const sent: SentMessage[] = [];
  const sender: EmailSender = {
    provider: 'cloudflare',
    send: async (envelope, context) => {
      const resolved =
        typeof resolvedResult === 'function'
          ? resolvedResult(sent.length)
          : resolvedResult;
      sent.push({ context, envelope });
      return resolved;
    },
  };
  return { sender, sent };
};

const logLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(
    (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
  );

const cloudflareBinding = (): NonNullable<Env['EMAIL']> => ({
  send: async () => ({ messageId: 'binding-message' }),
});

const enableCloudflare = async (): Promise<void> => {
  fixture.setEmailBinding(cloudflareBinding());
  await fixture.enableProvider({ provider: 'cloudflare' });
};

const seedRecipient = async (
  id: string,
  email: string,
  options: { disabled?: boolean; optIn?: boolean } = {},
): Promise<void> => {
  await fixture.user({ disabled: options.disabled, email, id });
  await fixture.optIn(id, options.optIn ?? true);
};

describe('lead.created email subscriber', () => {
  test('sends one generic message per opted-in, enabled recipient', async () => {
    await enableCloudflare();
    await seedRecipient(ACTOR_ID, 'creator@example.test');
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test', { optIn: false });
    await seedRecipient('staff-3', 'staff-3@example.test', { disabled: true });
    await fixture.seedLead(LEAD_ID);

    const { sender, sent } = recordingSender();
    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: ACTOR_ID,
      leadId: LEAD_ID,
    });

    expect(sent.map((message) => message.envelope.to)).toEqual([
      'staff-1@example.test',
    ]);
    const [sentMessage] = sent;
    expect(sentMessage.envelope.subject).toBe(
      'A new lead is available in LeadScroll',
    );
    expect(sentMessage.envelope.html).toContain(
      `https://crm.example.test/leads/${LEAD_ID}`,
    );
    expect(sentMessage.envelope.from).toEqual({
      email: 'notifications@example.test',
      name: 'LeadScroll',
    });
    expect(sentMessage.context.deliveryKey).toBe(
      `leadscroll-notification:${LEAD_ID}:staff-1`,
    );
    // The creator is excluded, so no message may address the actor.
    expect(sent.map((entry) => entry.envelope.to)).not.toContain(
      'creator@example.test',
    );
  });

  test('does not call the provider while disabled or misconfigured', async () => {
    const { sender, sent } = recordingSender();

    // Disabled installation.
    await fixture.seedLead(LEAD_ID);
    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });
    expect(sent).toHaveLength(0);

    // Enabled but the selected Cloudflare provider has no binding.
    await fixture.enableProvider({ provider: 'cloudflare' });
    await seedRecipient('staff-1', 'staff-1@example.test');
    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });
    expect(sent).toHaveLength(0);
  });

  test('never falls back to another provider when the selected one is missing', async () => {
    // Resend is selected without a stored credential; a present Cloudflare
    // binding must not be touched.
    const bindingCalls = vi.fn(async () => ({ messageId: 'cf' }));
    fixture.setEmailBinding({ send: bindingCalls });
    await fixture.enableProvider({ provider: 'resend' });
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);

    await createLeadCreatedEmailSubscriber()(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });

    expect(bindingCalls).not.toHaveBeenCalled();
  });

  test('skips when the lead is gone and when no recipient opted in', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    const { sender, sent } = recordingSender();

    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });
    expect(sent).toHaveLength(0);

    await fixture.seedLead(LEAD_ID);
    await fixture.optIn('staff-1', false);
    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });
    expect(sent).toHaveLength(0);
  });

  test('one recipient failure does not stop the others', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test');
    await seedRecipient('staff-3', 'staff-3@example.test');
    await fixture.seedLead(LEAD_ID);

    const { sender, sent } = recordingSender((call) =>
      call === 0
        ? {
            kind: 'rejected',
            provider: 'cloudflare',
            reason: 'E_RECIPIENT_NOT_ALLOWED',
            retryable: false,
          }
        : { kind: 'accepted', provider: 'cloudflare' },
    );

    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });

    expect(sent).toHaveLength(3);
  });

  test('respects the bounded concurrency limit', async () => {
    await enableCloudflare();
    for (let index = 0; index < 6; index += 1) {
      await seedRecipient(`staff-${index}`, `staff-${index}@example.test`);
    }

    await fixture.seedLead(LEAD_ID);

    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const sender: EmailSender = {
      provider: 'cloudflare',
      send: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            inFlight -= 1;
            resolve();
          });
        });
        return { kind: 'accepted', provider: 'cloudflare' };
      },
    };

    const work = createLeadCreatedEmailSubscriber({
      concurrency: 2,
      sender,
    })(fixture.env, { actorUserId: null, leadId: LEAD_ID });

    // Let the first wave start, then release the rest as they arrive.
    while (releases.length === 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    expect(maxInFlight).toBe(2);
    for (let index = 0; index < 6; index += 1) {
      while (releases.length <= index) {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      }

      releases[index]();
    }

    await work;
    expect(maxInFlight).toBe(2);
  });

  test('passes a finite per-send timeout bounded by the background budget', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);
    const { sender, sent } = recordingSender();

    await createLeadCreatedEmailSubscriber({
      budgetMs: 5_000,
      sender,
    })(fixture.env, { actorUserId: null, leadId: LEAD_ID });

    expect(sent).toHaveLength(1);
    const timeout = sent[0].context.timeoutMs;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(5_000);
    expect(timeout).toBeLessThanOrEqual(NOTIFICATION_PROVIDER_TIMEOUT_MS);
    expect(timeout).toBeLessThanOrEqual(NOTIFICATION_BUDGET_MS);
  });

  test('reports budget exhaustion instead of silently dropping recipients', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test');
    await fixture.seedLead(LEAD_ID);
    const { sender, sent } = recordingSender();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createLeadCreatedEmailSubscriber({
      budgetMs: 0,
      sender,
    })(fixture.env, { actorUserId: null, leadId: LEAD_ID });

    expect(sent).toHaveLength(0);
    const outcomes = logLines(logSpy).filter(
      (line) => line.outcome === 'skipped',
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      reason: 'budget_exhausted',
      recipients: 2,
      skipped: 2,
    });
  });

  test('honest timeout results are reported as failed and never retried', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test');
    await fixture.seedLead(LEAD_ID);
    const { sender, sent } = recordingSender({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'timeout',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });

    expect(sent).toHaveLength(2);
    const outcome = logLines(errorSpy).find(
      (line) => line.outcome === 'failed',
    );
    expect(outcome).toMatchObject({ reason: 'cloudflare_timeout', skipped: 0 });
  });

  test('preparation time consumes the budget before the first send', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);
    const { sender, sent } = recordingSender();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = Date.now();
    let clockCalls = 0;

    await createLeadCreatedEmailSubscriber({
      budgetMs: 5_000,
      // The first call records the entry time; every later call simulates a
      // preparation phase that consumed far more than the budget.
      now: () => new Date(clockCalls++ === 0 ? base : base + 60_000),
      sender,
    })(fixture.env, { actorUserId: null, leadId: LEAD_ID });

    expect(sent).toHaveLength(0);
    const outcomes = logLines(logSpy).filter(
      (line) => line.outcome === 'skipped',
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      reason: 'budget_exhausted',
      recipients: 1,
      skipped: 1,
    });
  });

  test('a Cloudflare timeout stops launching new recipients for the event', async () => {
    await enableCloudflare();
    for (let index = 0; index < 6; index += 1) {
      await seedRecipient(`staff-${index}`, `staff-${index}@example.test`);
    }

    await fixture.seedLead(LEAD_ID);
    const send = vi.fn(() => new Promise<{ messageId: string }>(() => {}));
    const sender = createCloudflareEmailSender({
      send,
    } as unknown as NonNullable<Env['EMAIL']>);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createLeadCreatedEmailSubscriber({
      budgetMs: 10_000,
      concurrency: 4,
      providerTimeoutMs: 20,
      sender,
    })(fixture.env, { actorUserId: null, leadId: LEAD_ID });

    // One lane per concurrency slot, and no replacement launches after the
    // first timeout because the native binding call cannot be canceled.
    expect(send).toHaveBeenCalledTimes(4);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(send).toHaveBeenCalledTimes(4);

    const outcomes = logLines(errorSpy);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      failed: 4,
      outcome: 'failed',
      reason: 'cloudflare_timeout',
      recipients: 6,
      skipped: 2,
    });
  });

  test('outcome logging carries counts and never addresses or payloads', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'private-staff@example.test');
    await fixture.seedLead(LEAD_ID);
    const { sender } = recordingSender();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createLeadCreatedEmailSubscriber({ sender })(fixture.env, {
      actorUserId: null,
      leadId: LEAD_ID,
    });

    const lines = logLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      accepted: 1,
      event: 'notification.event',
      eventKind: 'lead.created',
      leadId: LEAD_ID,
      outcome: 'delivered',
      provider: 'cloudflare',
      recipients: 1,
    });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('private-staff@example.test');
    expect(serialized).not.toContain('A new lead is available');
  });
});
