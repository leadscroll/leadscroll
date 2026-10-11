import {
  applyMigrationsFrom,
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { DEFAULT_WORKSPACE_ID } from '@/db/repository';
import { afterEach, describe, expect, test } from 'vitest';

const fixtures: NotificationFixture[] = [];

const fixture = async (options: { through?: string } = {}) => {
  const value = await startNotificationFixture(options);
  fixtures.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (value) => value.dispose()));
});

describe('notification schema migration', () => {
  test('notification preferences default off and are unique per user', async () => {
    const fx = await fixture();
    await fx.user({ email: 'schema@example.test', id: 'schema-user' });
    await fx.db
      .prepare(
        'INSERT INTO notification_preferences (workspace_id, user_id, updated_at) VALUES (?, ?, ?)',
      )
      .bind(DEFAULT_WORKSPACE_ID, 'schema-user', Date.now())
      .run();
    const row = await fx.db
      .prepare(
        'SELECT new_lead_email FROM notification_preferences WHERE user_id = ?',
      )
      .bind('schema-user')
      .first<{ new_lead_email: number }>();
    expect(Number(row?.new_lead_email)).toBe(0);

    await expect(
      fx.db
        .prepare(
          'INSERT INTO notification_preferences (workspace_id, user_id, updated_at) VALUES (?, ?, ?)',
        )
        .bind(DEFAULT_WORKSPACE_ID, 'schema-user', Date.now())
        .run(),
    ).rejects.toThrow(/UNIQUE constraint/iu);
  });

  test('migration 0004 is additive: existing baselines and claims survive', async () => {
    const fx = await fixture({ through: '0003' });
    await fx.user({ email: 'bootstrap@example.test', id: 'bootstrap-user' });
    await fx.seedLead('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await fx.db
      .prepare(
        `INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at)
          VALUES (?, 'bootstrap', 'bootstrap', 'bootstrap', ?, ?)`,
      )
      .bind('claim-1', 'bootstrap-user', Date.now())
      .run();

    await applyMigrationsFrom(fx.db, '0004');

    expect(await fx.count('leads')).toBe(1);
    expect(await fx.count('user')).toBe(1);
    expect(await fx.count('registration_claims')).toBe(1);
    const granted = await fx.db
      .prepare(
        'SELECT user_id FROM email_settings_permissions WHERE workspace_id = ?',
      )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<{ user_id: string }>();
    expect(granted?.user_id).toBe('bootstrap-user');
  });

  test('the migration backfill does not grant the capability to a disabled bootstrap owner', async () => {
    const fx = await fixture({ through: '0003' });
    await fx.user({
      disabled: true,
      email: 'bootstrap@example.test',
      id: 'bootstrap-user',
    });
    await fx.db
      .prepare(
        `INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at)
          VALUES (?, 'bootstrap', 'bootstrap', 'bootstrap', ?, ?)`,
      )
      .bind('claim-2', 'bootstrap-user', Date.now())
      .run();

    await applyMigrationsFrom(fx.db, '0004');
    expect(await fx.count('email_settings_permissions')).toBe(0);
  });

  test('fresh installs create only the final notification schema', async () => {
    const fx = await fixture();
    for (const table of [
      'email_credentials',
      'email_settings',
      'email_settings_audit',
      'email_settings_permissions',
      'notification_preferences',
      'notification_test_attempts',
    ]) {
      expect(await fx.count(table)).toBe(0);
    }

    for (const table of [
      'notification_outbox',
      'notification_dispatch_state',
    ]) {
      await expect(
        fx.db.prepare(`SELECT 1 FROM ${table}`).first(),
      ).rejects.toThrow(/no such table/iu);
    }

    const settingsColumns = await fx.db
      .prepare('PRAGMA table_info(email_settings)')
      .all<{ name: string }>();
    expect(settingsColumns.results.map((column) => column.name)).toEqual([
      'canonical_origin',
      'enabled',
      'from_email',
      'from_name',
      'provider',
      'revision',
      'updated_at',
      'updated_by_user_id',
      'workspace_id',
      'write_token',
    ]);
    const testColumns = await fx.db
      .prepare('PRAGMA table_info(notification_test_attempts)')
      .all<{ name: string }>();
    expect(testColumns.results.map((column) => column.name)).toEqual([
      'completed_at',
      'config_revision',
      'created_at',
      'id',
      'provider',
      'provider_message_id',
      'reason_code',
      'status',
      'updated_at',
      'user_id',
      'workspace_id',
    ]);
  });
});
