import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  getNotificationPreferenceView,
  updateNotificationPreferenceCommand,
} from '@/application/notification-commands';
import { getNotificationPreference } from '@/db/repository';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const USER_ID = 'pref-user';

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  await fixture.user({ email: 'pref@example.test', id: USER_ID });
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

  test('reports configured, disabled, and misconfigured availability from safe inputs', async () => {
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

    // The installation switch being off is reported separately from a
    // configuration problem.
    await fixture.enableProvider({ enabled: false, provider: 'cloudflare' });
    expect(
      (await getNotificationPreferenceView(fixture.env, USER_ID)).availability,
    ).toBe('disabled');
  });
});
