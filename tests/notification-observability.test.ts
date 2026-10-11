import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { logNotificationDispatchOutcome } from '@/api/logging';
import {
  processNextNotification,
  runNotificationDispatch,
} from '@/application/notification-commands';
import {
  getNotificationDispatchHealth,
  recordNotificationDispatchTick,
} from '@/db/repository';
import { type EmailSender } from '@/notifications/email';
import { classifyCloudflareError } from '@/notifications/providers/cloudflare';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = 'observability-user';
const HOUR = 60 * 60 * 1_000;

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  await fixture.enableProvider({ provider: 'cloudflare' });
  fixture.setEmailBinding({
    send: async () => ({ messageId: 'obs-cf' }),
  });
  await fixture.user({ email: 'obs@example.test', id: USER_ID });
  await fixture.optIn(USER_ID);
  await fixture.seedLead(LEAD_ID);
});

describe('notification dispatch logging', () => {
  test('emits only safe fields and reduces unknown reasons to unclassified', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      logNotificationDispatchOutcome({
        attempt: 2,
        kind: 'failed',
        outboxId: 'out-opaque',
        reasonCode: 'E_SENDER_NOT_VERIFIED',
      });
      logNotificationDispatchOutcome({
        kind: 'unknown',
        outboxId: 'out-opaque-2',
        reasonCode: 'SENTINEL address@example.test body text',
      });
      lines = log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines.at(0) ?? '')).toEqual({
      attempt: 2,
      event: 'notification.dispatch',
      outboxId: 'out-opaque',
      outcome: 'failed',
      reason: 'E_SENDER_NOT_VERIFIED',
    });
    expect(JSON.parse(lines.at(1) ?? '')).toEqual({
      event: 'notification.dispatch',
      outboxId: 'out-opaque-2',
      outcome: 'unknown',
      reason: 'unclassified',
    });
    expect(lines.join(' ')).not.toContain('SENTINEL');
    expect(lines.join(' ')).not.toContain('address@example.test');
  });

  test('a processed outcome logs one redacted line with the outbox id', async () => {
    await fixture.insertOutbox({
      id: 'obs-outbox',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let outcome;
    let lines: string[] = [];
    try {
      outcome = await processNextNotification(fixture.env);
      lines = log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }

    expect(outcome).toMatchObject({ kind: 'accepted' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines.at(0) ?? '');
    expect(parsed).toMatchObject({
      attempt: 1,
      event: 'notification.dispatch',
      outboxId: 'obs-outbox',
      outcome: 'accepted',
    });
    expect(lines[0]).not.toContain('obs@example.test');
    expect(lines[0]).not.toContain('LeadScroll');
  });

  test('unexpected provider error text never reaches the log via a reason code', async () => {
    await fixture.insertOutbox({
      id: 'obs-sentinel',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
    });
    const sender: EmailSender = {
      capabilities: { idempotencyWindowSeconds: null },
      checkConfiguration: () => ({ configured: true }),
      provider: 'cloudflare',
      send: async () => ({
        kind: 'ambiguous',
        provider: 'cloudflare',
        reason: 'SENTINEL provider body',
      }),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[] = [];
    try {
      await processNextNotification(fixture.env, { sender });
      lines = log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"reason":"unclassified"');
    expect(lines[0]).not.toContain('SENTINEL');
  });
});

describe('dispatch health', () => {
  test('reports tick state and redacted counts', async () => {
    const now = new Date();
    await recordNotificationDispatchTick(fixture.env, now);
    await fixture.insertOutbox({
      id: 'health-pending',
      leadId: LEAD_ID,
      next_attempt_at: now.getTime() - HOUR,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
      status: 'pending',
    });
    await fixture.insertOutbox({
      id: 'health-retry',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
    });
    await fixture.insertOutbox({
      id: 'health-unknown',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
      status: 'unknown',
    });
    await fixture.insertOutbox({
      id: 'health-sending',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
      status: 'sending',
    });
    await fixture.insertOutbox({
      id: 'health-accepted',
      leadId: LEAD_ID,
      recipient_email: 'obs@example.test',
      recipient_user_id: USER_ID,
      status: 'accepted',
    });

    const health = await getNotificationDispatchHealth(fixture.env);
    expect(health.dispatch?.lastTickAt?.getTime()).toBe(now.getTime());
    expect(health.pending).toBe(2);
    expect(health.inFlight).toBe(1);
    expect(health.unknown).toBe(1);
    expect(health.oldestDueAt?.getTime()).toBe(now.getTime() - HOUR);
  });

  test('dispatch still records a tick and runs bounded maintenance while disabled', async () => {
    await fixture.db
      .prepare(
        "UPDATE email_settings SET enabled = 0 WHERE workspace_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'",
      )
      .run();
    const result = await runNotificationDispatch(fixture.env);
    expect(result.stopped).toBe('unavailable');
    const health = await getNotificationDispatchHealth(fixture.env);
    expect(health.dispatch?.lastTickAt).toBeInstanceOf(Date);
  });
});

describe('provider error sanitization', () => {
  test('unrecognizable cloudflare codes collapse to a fixed reason', () => {
    expect(
      classifyCloudflareError(
        Object.assign(new Error('x'), { code: 'SENTINEL secret body' }),
      ),
    ).toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'binding_failure',
    });
    expect(
      classifyCloudflareError(
        Object.assign(new Error('x'), { code: 'E_SOMETHING_NEW' }),
      ),
    ).toEqual({
      kind: 'ambiguous',
      provider: 'cloudflare',
      reason: 'E_SOMETHING_NEW',
    });
  });
});
