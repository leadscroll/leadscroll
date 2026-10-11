import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  redeemRegistration,
  RegistrationError,
} from '@/auth/registration-repository';
import { DEFAULT_WORKSPACE_ID } from '@/db/repository';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
});

afterEach(async () => {
  await fixture.dispose();
});

describe('bootstrap email administrator seeding', () => {
  test('a fresh bootstrap registration grants the capability atomically', async () => {
    await redeemRegistration(fixture.db, {
      accountId: 'account-boot',
      email: 'boot@example.test',
      grant: { kind: 'bootstrap' },
      name: 'Boot',
      now: Date.now(),
      passwordHash: 'hash',
      userId: 'boot-user',
    });

    const granted = await fixture.db
      .prepare(
        'SELECT user_id FROM email_settings_permissions WHERE workspace_id = ?',
      )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<{ user_id: string }>();
    expect(granted?.user_id).toBe('boot-user');
  });

  test('an invited registration never receives the capability implicitly', async () => {
    await fixture.db
      .prepare(
        `INSERT INTO staff_invites (
          id, name, prefix, token_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'invite-1',
        'Invite',
        'abc',
        'invite-hash',
        Date.now(),
        Date.now() + 86_400_000,
      )
      .run();

    await redeemRegistration(fixture.db, {
      accountId: 'account-invited',
      email: 'invited@example.test',
      grant: { kind: 'invite', tokenHash: 'invite-hash' },
      name: 'Invited',
      now: Date.now(),
      passwordHash: 'hash',
      userId: 'invited-user',
    });

    expect(await fixture.count('email_settings_permissions')).toBe(0);
  });

  test('a consumed bootstrap grant cannot seed a second administrator', async () => {
    await redeemRegistration(fixture.db, {
      accountId: 'account-boot',
      email: 'boot@example.test',
      grant: { kind: 'bootstrap' },
      name: 'Boot',
      now: Date.now(),
      passwordHash: 'hash',
      userId: 'boot-user',
    });

    await expect(
      redeemRegistration(fixture.db, {
        accountId: 'account-second',
        email: 'second@example.test',
        grant: { kind: 'bootstrap' },
        name: 'Second',
        now: Date.now(),
        passwordHash: 'hash',
        userId: 'second-user',
      }),
    ).rejects.toBeInstanceOf(RegistrationError);
    expect(await fixture.count('user')).toBe(1);
    expect(await fixture.count('email_settings_permissions')).toBe(1);
  });
});
