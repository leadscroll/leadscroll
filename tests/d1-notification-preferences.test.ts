import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  getNotificationPreferenceView,
  listNotificationHistoryCommand,
  notificationReasonLabel,
  notificationStatusLabel,
  updateNotificationPreferenceCommand,
} from '@/application/notification-commands';
import {
  getNotificationPreference,
  listNotificationHistory,
} from '@/db/repository';
import { decodeKeysetCursor } from '@/domain/pagination';
import { Effect, Either } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const USER_ID = 'pref-user';
const OTHER_ID = 'pref-other';
const LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  await fixture.user({ email: 'pref@example.test', id: USER_ID });
  await fixture.user({ email: 'other@example.test', id: OTHER_ID });
  await fixture.seedLead(LEAD_ID);
});

afterEach(async () => {
  await fixture.dispose();
});

describe('notification preferences', () => {
  test('defaults off, toggles through the command, and survives service state', async () => {
    const initial = await getNotificationPreferenceView(fixture.env, USER_ID);
    expect(initial).toEqual({
      availability: 'disabled',
      newLeadEmail: false,
      provider: null,
    });

    const saved = await Effect.runPromise(
      updateNotificationPreferenceCommand(fixture.env, USER_ID, true),
    );
    expect(saved.newLeadEmail).toBe(true);
    expect(
      (await getNotificationPreference(fixture.env, USER_ID))?.newLeadEmail,
    ).toBe(true);

    await fixture.enableProvider({ enabled: false });
    const stillSaved = await getNotificationPreferenceView(
      fixture.env,
      USER_ID,
    );
    expect(stillSaved.newLeadEmail).toBe(true);
    expect(stillSaved.availability).toBe('disabled');
  });

  test('reports configured, misconfigured, and paused availability from safe inputs', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'stub' }),
    });
    expect(
      (await getNotificationPreferenceView(fixture.env, USER_ID)).availability,
    ).toBe('configured');

    fixture.setEmailBinding(undefined);
    const misconfigured = await getNotificationPreferenceView(
      fixture.env,
      USER_ID,
    );
    expect(misconfigured.availability).toBe('misconfigured');
    expect(misconfigured.provider).toBe('cloudflare');

    await fixture.enableProvider({
      pausedReasonCode: 'E_SENDER_NOT_VERIFIED',
      provider: 'cloudflare',
      revision: 2,
    });
    expect(
      (await getNotificationPreferenceView(fixture.env, USER_ID)).availability,
    ).toBe('unavailable');
  });
});

describe('notification history', () => {
  const insertRow = (
    id: string,
    userId: string,
    createdAt: number,
    overrides: Record<string, unknown> = {},
  ) =>
    fixture.insertOutbox({
      created_at: createdAt,
      id,
      leadId: LEAD_ID,
      recipient_email:
        userId === USER_ID ? 'pref@example.test' : 'other@example.test',
      recipient_user_id: userId,
      ...overrides,
    });

  test('returns only the caller rows, newest first, with pagination', async () => {
    const base = Date.now();
    await insertRow('h1', USER_ID, base - 3_000);
    await insertRow('h2', USER_ID, base - 2_000);
    await insertRow('h3', USER_ID, base - 1_000);
    await insertRow('other-1', OTHER_ID, base);

    const first = await listNotificationHistory(fixture.env, USER_ID, null, 2);
    expect(first.items.map((item) => item.id)).toEqual(['h3', 'h2']);
    expect(first.nextCursor).not.toBeNull();

    const cursor = first.nextCursor;
    const second = await listNotificationHistory(
      fixture.env,
      USER_ID,
      cursor === null ? null : decodeKeysetCursor(cursor),
      2,
    );
    expect(second.items.map((item) => item.id)).toEqual(['h1']);

    const view = await Effect.runPromise(
      listNotificationHistoryCommand(fixture.env, USER_ID, cursor, 2),
    );
    expect(view.data.map((item) => item.id)).toEqual(['h1']);
    expect(view.data[0]).toMatchObject({
      status: 'pending',
      statusLabel: 'Pending',
    });
    expect(view.nextCursor).toBeNull();
  });

  test('invalid cursors fail with a stable domain error', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        listNotificationHistoryCommand(
          fixture.env,
          USER_ID,
          'not-a-cursor',
          10,
        ),
      ),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'invalid_cursor' });
    }
  });

  test('history labels never expose raw provider detail', () => {
    expect(notificationStatusLabel('accepted')).toBe(
      'Accepted by email service',
    );
    expect(notificationStatusLabel('unknown')).toBe('Outcome unknown');
    expect(notificationReasonLabel('E_SENDER_NOT_VERIFIED')).toBe(
      'Delivery needs attention.',
    );
    expect(notificationReasonLabel('expired')).toBe('Expired before sending.');
    expect(notificationReasonLabel(null)).toBeNull();
  });
});
