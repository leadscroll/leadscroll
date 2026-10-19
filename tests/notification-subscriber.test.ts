import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  makeNotificationRuntime,
  manualClock,
  recordingProvider,
  recordingResolver,
  resolverLayer,
  runEffect,
} from './notification-services';
import { type Env } from '@/db/repository';
import { type SendResult } from '@/notifications/email';
import { type EmailProviderService } from '@/notifications/email-provider';
import {
  createLeadCreatedEmailSubscriber,
  NOTIFICATION_BUDGET_MS,
  NOTIFICATION_PROVIDER_TIMEOUT_MS,
} from '@/notifications/lead-created-subscriber';
import { NOTIFICATION_SUBJECT } from '@/notifications/templates';
import { Effect } from 'effect';
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

    const { calls, provider } = recordingProvider();
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: ACTOR_ID,
        leadId: LEAD_ID,
      }),
    );

    expect(calls.map((call) => call.envelope.to)).toEqual([
      'staff-1@example.test',
    ]);
    const [sentMessage] = calls;
    expect(sentMessage.envelope.subject).toBe(NOTIFICATION_SUBJECT);
    expect(sentMessage.envelope.html).toContain(
      `https://crm.example.test/leads/${LEAD_ID}`,
    );
    expect(sentMessage.envelope.from).toEqual({
      email: 'notifications@example.test',
      name: 'LeadScroll',
    });
    expect(sentMessage.deliveryKey).toBe(
      `leadscroll-notification:${LEAD_ID}:staff-1`,
    );
    // The creator is excluded, so no message may address the actor.
    expect(calls.map((entry) => entry.envelope.to)).not.toContain(
      'creator@example.test',
    );
  });

  test('does not resolve a provider while disabled or misconfigured', async () => {
    const { calls, provider } = recordingProvider();
    const resolved: string[] = [];
    const runtime = makeNotificationRuntime(
      fixture.env,
      resolverLayer((email) =>
        Effect.sync(() => {
          resolved.push(email.provider);
          return provider;
        }),
      ),
    );
    const subscriber = createLeadCreatedEmailSubscriber(fixture.env);
    await fixture.seedLead(LEAD_ID);

    // Disabled installation.
    await runEffect(
      runtime,
      subscriber({ actorUserId: null, leadId: LEAD_ID }),
    );
    expect(calls).toHaveLength(0);
    expect(resolved).toHaveLength(0);

    // Enabled but the selected Cloudflare provider has no binding.
    await fixture.enableProvider({ provider: 'cloudflare' });
    await seedRecipient('staff-1', 'staff-1@example.test');
    await runEffect(
      runtime,
      subscriber({ actorUserId: null, leadId: LEAD_ID }),
    );
    expect(calls).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });

  test('never falls back to another provider when the selected one is missing', async () => {
    // Resend is selected without a stored credential; a present Cloudflare
    // binding must not be touched. Uses the real resolver layer.
    const bindingCalls = vi.fn(async () => ({ messageId: 'cf' }));
    fixture.setEmailBinding({ send: bindingCalls });
    await fixture.enableProvider({ provider: 'resend' });
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);

    const runtime = makeNotificationRuntime(fixture.env);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    expect(bindingCalls).not.toHaveBeenCalled();
    expect(logLines(logSpy)[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'resend_api_key_missing',
    });
  });

  test('skips when the lead is gone and when no recipient opted in', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    const { calls, provider } = recordingProvider();
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const subscriber = createLeadCreatedEmailSubscriber(fixture.env);

    await runEffect(
      runtime,
      subscriber({ actorUserId: null, leadId: LEAD_ID }),
    );
    expect(calls).toHaveLength(0);

    await fixture.seedLead(LEAD_ID);
    await fixture.optIn('staff-1', false);
    await runEffect(
      runtime,
      subscriber({ actorUserId: null, leadId: LEAD_ID }),
    );
    expect(calls).toHaveLength(0);
  });

  test('one recipient failure does not stop the others', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test');
    await seedRecipient('staff-3', 'staff-3@example.test');
    await fixture.seedLead(LEAD_ID);

    const { calls, provider } = recordingProvider((_input, call): SendResult =>
      call === 0
        ? {
            kind: 'rejected',
            provider: 'cloudflare',
            reason: 'E_RECIPIENT_NOT_ALLOWED',
            retryable: false,
          }
        : { kind: 'accepted', provider: 'cloudflare' },
    );
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );

    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    expect(calls).toHaveLength(3);
  });

  test('bounds concurrent sends to the configured fan-out', async () => {
    await enableCloudflare();
    for (let index = 0; index < 6; index += 1) {
      await seedRecipient(`staff-${index}`, `staff-${index}@example.test`);
    }

    await fixture.seedLead(LEAD_ID);

    const counter = { inFlight: 0, max: 0 };
    const countingProvider: EmailProviderService = {
      kind: 'cloudflare',
      policy: { timeoutIsUncancelable: true },
      send: () =>
        Effect.gen(function* () {
          counter.inFlight += 1;
          counter.max = Math.max(counter.max, counter.inFlight);
          yield* Effect.sleep('15 millis');
          counter.inFlight -= 1;
          return { kind: 'accepted' as const, provider: 'cloudflare' as const };
        }),
    };
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(countingProvider),
    );
    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    expect(counter.max).toBe(4);
    expect(counter.inFlight).toBe(0);
  });

  test('preparation time consumes the budget before the first send', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);
    const { calls, provider } = recordingProvider();
    const clock = manualClock(1_000);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Simulate credential/provider preparation consuming 60s of the 20s
    // budget after the subscriber recorded its entry time.
    const runtime = makeNotificationRuntime(
      fixture.env,
      resolverLayer(() =>
        Effect.sync(() => {
          clock.advance(60_000);
        }).pipe(Effect.as(provider)),
      ),
      clock.layer,
    );

    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    expect(calls).toHaveLength(0);
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

  test('an uncancelable provider timeout stops launching new recipients', async () => {
    await enableCloudflare();
    for (let index = 0; index < 6; index += 1) {
      await seedRecipient(`staff-${index}`, `staff-${index}@example.test`);
    }

    await fixture.seedLead(LEAD_ID);
    const { calls, provider } = recordingProvider(() =>
      Effect.sleep('15 millis').pipe(
        Effect.as({
          kind: 'ambiguous' as const,
          provider: 'cloudflare' as const,
          reason: 'timeout',
        }),
      ),
    );
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    // One call per concurrency slot, no replacement launches after the first
    // timeout, and the two unsent recipients are reported.
    expect(calls).toHaveLength(4);
    const outcomes = logLines(errorSpy);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      failed: 4,
      outcome: 'failed',
      reason: 'uncancelable_timeout',
      recipients: 6,
      skipped: 2,
    });
  });

  test('the stop policy is provider-neutral, not Cloudflare-specific', async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_test');
    await seedRecipient('staff-1', 'staff-1@example.test');
    await seedRecipient('staff-2', 'staff-2@example.test');
    await fixture.seedLead(LEAD_ID);

    // Delay the timeout so both concurrency lanes start before the first
    // result lands; the stop decision must come from the neutral policy.
    const { calls, provider } = recordingProvider(() =>
      Effect.sleep('15 millis').pipe(
        Effect.as({
          kind: 'ambiguous' as const,
          provider: 'resend' as const,
          reason: 'timeout',
        }),
      ),
    );
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    // Both lanes started before the first timeout landed, and no further
    // launches occurred; the stop decision came from the neutral policy.
    expect(calls).toHaveLength(2);
  });

  test('passes a finite per-send timeout bounded by the background budget', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'staff-1@example.test');
    await fixture.seedLead(LEAD_ID);
    const { calls, provider } = recordingProvider();
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );

    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(
      NOTIFICATION_PROVIDER_TIMEOUT_MS,
    );
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(NOTIFICATION_BUDGET_MS);
  });

  test('outcome logging carries counts and never addresses or payloads', async () => {
    await enableCloudflare();
    await seedRecipient('staff-1', 'private-staff@example.test');
    await fixture.seedLead(LEAD_ID);
    const { provider } = recordingProvider();
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEffect(
      runtime,
      createLeadCreatedEmailSubscriber(fixture.env)({
        actorUserId: null,
        leadId: LEAD_ID,
      }),
    );

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
    expect(serialized).not.toContain('A new lead just came in');
  });
});
