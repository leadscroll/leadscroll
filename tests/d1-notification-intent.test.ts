import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { createIntakeCommand, createLeadCommand } from '@/application/commands';
import { getIntakeKey } from '@/db/repository';
import { type IntakeRequest } from '@/domain/schemas';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const USERS = {
  actor: { email: 'actor@example.test', id: 'user-actor' },
  disabled: { email: 'disabled@example.test', id: 'user-disabled' },
  optedOut: { email: 'off@example.test', id: 'user-off' },
  other: { email: 'other@example.test', id: 'user-other' },
};

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  for (const user of Object.values(USERS)) {
    await fixture.user({
      email: user.email,
      id: user.id,
      ...(user === USERS.disabled ? { disabled: true } : {}),
    });
  }

  await fixture.optIn(USERS.actor.id);
  await fixture.optIn(USERS.other.id);
  await fixture.optIn(USERS.optedOut.id, false);
  await fixture.optIn(USERS.disabled.id);
});

afterEach(async () => {
  await fixture.dispose();
});

const intake = (): IntakeRequest => ({
  email: 'new-lead@example.test',
  firstName: 'New',
  source: 'website_form',
});

const runIntake = (key: string, input: IntakeRequest = intake()) =>
  Effect.runPromise(
    createIntakeCommand(fixture.env, input, key, {
      origin: 'https://evil.example',
      tokenId: 'token-1',
    }),
  );

const outboxFor = async (recipientId: string) => {
  const result = await fixture.db
    .prepare(
      'SELECT id, event_key, recipient_email, status FROM notification_outbox WHERE recipient_user_id = ? ORDER BY recipient_email',
    )
    .bind(recipientId)
    .all<{
      event_key: string;
      id: number;
      recipient_email: string;
      status: string;
    }>();
  return result.results;
};

describe('atomic notification intent', () => {
  test('records one durable row per opted-in enabled recipient on intake', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });

    const outcome = await runIntake('intake-key-1');
    expect(outcome.kind).toBe('created');
    expect(await fixture.count('notification_outbox')).toBe(2);

    const actorRows = await outboxFor(USERS.actor.id);
    expect(actorRows).toHaveLength(1);
    expect(actorRows[0].status).toBe('pending');
    expect(actorRows[0].recipient_email).toBe('actor@example.test');
    expect(actorRows[0].event_key).toMatch(/^lead\.created:/u);
    expect(await outboxFor(USERS.optedOut.id)).toHaveLength(0);
    expect(await outboxFor(USERS.disabled.id)).toHaveLength(0);
  });

  test('a disabled installation creates no intent, while a misconfigured enabled one keeps it', async () => {
    await fixture.enableProvider({ enabled: false });
    await runIntake('intake-disabled');
    expect(await fixture.count('notification_outbox')).toBe(0);

    await fixture.db
      .prepare(
        "UPDATE email_settings SET enabled = 1, provider = 'cloudflare' WHERE workspace_id = ?",
      )
      .bind('01ARZ3NDEKTSV4RRFFQ69G5FAV')
      .run();
    // Enabled but the EMAIL binding is absent: intent is durable so it can be
    // delivered after the owner completes the configuration.
    await runIntake('intake-misconfigured');
    expect(await fixture.count('notification_outbox')).toBe(2);
  });

  test('manual creation excludes the actor but not other subscribers', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    await Effect.runPromise(
      createLeadCommand(
        fixture.env,
        { email: 'manual@example.test', firstName: 'Manual', source: 'Manual' },
        USERS.actor.id,
      ),
    );

    const rows = await fixture.db
      .prepare(
        'SELECT recipient_user_id FROM notification_outbox ORDER BY recipient_user_id',
      )
      .all<{ recipient_user_id: null | string }>();
    expect(rows.results).toEqual([{ recipient_user_id: USERS.other.id }]);
    expect(await outboxFor(USERS.actor.id)).toHaveLength(0);
  });

  test('an intake replay creates no additional rows', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    const first = await runIntake('replay-key');
    const replay = await runIntake('replay-key');
    expect(first.kind).toBe('created');
    expect(replay.kind).toBe('replayed');
    expect(await fixture.count('notification_outbox')).toBe(2);

    // The durable idempotency row is unchanged by the notification work.
    const stored = await getIntakeKey(fixture.env, 'replay-key');
    expect(stored?.responseJson).toMatchObject({ created: true });
  });

  test('a changed payload for the same key conflicts without new leads or rows', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    await runIntake('conflict-key');
    const conflict = await runIntake('conflict-key', {
      ...intake(),
      firstName: 'Changed',
    });
    expect(conflict.kind).toBe('conflict');
    expect(await fixture.count('leads')).toBe(1);
    expect(await fixture.count('notification_outbox')).toBe(2);
  });

  test('concurrent same-key intake produces one lead and one row per recipient', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    const [first, second] = await Promise.allSettled([
      runIntake('concurrent-key'),
      runIntake('concurrent-key'),
    ]);
    const kinds = [first, second].map((result) =>
      result.status === 'fulfilled' ? result.value.kind : 'rejected',
    );
    expect(kinds.toSorted()).toEqual(['created', 'replayed']);
    expect(await fixture.count('leads')).toBe(1);
    expect(await fixture.count('notification_outbox')).toBe(2);
    expect(await fixture.count('idempotency_keys')).toBe(1);
  });

  test('a failed batch rolls back the lead, idempotency row, and notification intent', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    // Force the shared atomic batch to fail after the lead insert by removing
    // the activity table: D1 batches are all-or-nothing.
    await fixture.db.prepare('DROP TABLE activities').run();

    await expect(runIntake('rollback-key')).rejects.toBeDefined();
    expect(await fixture.count('leads')).toBe(0);
    expect(await fixture.count('notification_outbox')).toBe(0);
    expect(await fixture.count('idempotency_keys')).toBe(0);
  });

  test('intake JSON cannot choose recipients, sender, or notification settings', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    const hostile = {
      ...intake(),
      notificationRecipients: ['attacker@example.test'],
      recipientEmail: 'attacker@example.test',
      sender: 'attacker@example.test',
    } as unknown as IntakeRequest;
    await runIntake('hostile-key', hostile);
    const emails = await fixture.db
      .prepare('SELECT recipient_email FROM notification_outbox ORDER BY 1')
      .all<{ recipient_email: string }>();
    expect(emails.results.map((row) => row.recipient_email)).toEqual([
      'actor@example.test',
      'other@example.test',
    ]);
    expect(
      (await fixture.db.prepare('SELECT raw_payload FROM leads').all()).results,
    ).toHaveLength(1);
  });
});
