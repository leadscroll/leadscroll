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

  test('migration 0006 drops delivery machinery and preserves configuration', async () => {
    const fx = await fixture({ through: '0005' });
    const now = Date.now();
    await fx.user({ email: 'owner@example.test', id: 'owner-user' });
    await fx.seedLead('01ARZ3NDEKTSV4RRFFQ69G5FAV');

    await fx.db
      .prepare(
        `INSERT INTO email_settings (
          workspace_id, provider, enabled, from_email, from_name,
          canonical_origin, revision, paused_revision, paused_reason_code,
          paused_at, updated_by_user_id, updated_at, write_token
        ) VALUES (?, 'resend', 1, 'sender@example.test', 'Sender',
          'https://crm.example.test', 2, 2, 'invalid_api_key', ?, ?, ?, 'token')`,
      )
      .bind(DEFAULT_WORKSPACE_ID, now, 'owner-user', now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO email_credentials (
          workspace_id, provider, ciphertext, nonce, key_version, updated_at,
          updated_by_user_id
        ) VALUES (?, 'resend', 'cipher', 'nonce', 1, ?, ?)`,
      )
      .bind(DEFAULT_WORKSPACE_ID, now, 'owner-user')
      .run();
    await fx.optIn('owner-user');
    await fx.db
      .prepare(
        `INSERT INTO email_settings_audit (
          id, workspace_id, actor_user_id, action, revision, test_outcome,
          reason_code, created_at
        ) VALUES ('audit-1', ?, ?, 'settings_saved', 2, NULL, NULL, ?)`,
      )
      .bind(DEFAULT_WORKSPACE_ID, 'owner-user', now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO notification_outbox (
          id, workspace_id, event_key, event_kind, lead_id, recipient_user_id,
          recipient_email, template_version, status, attempt_count,
          next_attempt_at, created_at, updated_at
        ) VALUES ('outbox-1', ?, 'lead.created:x', 'lead.created', ?, ?,
          'owner@example.test', 1, 'pending', 0, ?, ?, ?)`,
      )
      .bind(
        DEFAULT_WORKSPACE_ID,
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        'owner-user',
        now,
        now,
        now,
      )
      .run();
    await fx.db
      .prepare(
        `INSERT INTO notification_dispatch_state (
          workspace_id, last_tick_at, last_success_at, config_error_at,
          config_error_code, config_error_revision, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .bind(DEFAULT_WORKSPACE_ID, now, now)
      .run();

    await applyMigrationsFrom(fx.db, '0006');

    // Settings, credentials, preferences, audit, and CRM data survive.
    const settings = await fx.db
      .prepare(
        'SELECT provider, enabled, revision, from_email FROM email_settings WHERE workspace_id = ?',
      )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<Record<string, unknown>>();
    expect(settings).toMatchObject({
      enabled: 1,
      from_email: 'sender@example.test',
      provider: 'resend',
      revision: 2,
    });
    expect(await fx.count('email_credentials')).toBe(1);
    expect(await fx.count('notification_preferences')).toBe(1);
    expect(await fx.count('email_settings_audit')).toBe(1);
    expect(await fx.count('leads')).toBe(1);

    // Obsolete delivery tables and columns are gone.
    await expect(
      fx.db.prepare('SELECT 1 FROM notification_outbox').first(),
    ).rejects.toThrow(/no such table/iu);
    await expect(
      fx.db.prepare('SELECT 1 FROM notification_dispatch_state').first(),
    ).rejects.toThrow(/no such table/iu);
    await expect(
      fx.db.prepare('SELECT paused_at FROM email_settings').first(),
    ).rejects.toThrow(/no such column/iu);
    await expect(
      fx.db
        .prepare('SELECT delivery_key FROM notification_test_attempts')
        .first(),
    ).rejects.toThrow(/no such column/iu);
  });
});
