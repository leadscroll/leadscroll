import {
  applyMigrationsFrom,
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { getEmailSettingsViewCommand } from '@/application/notification-commands';
import {
  appendAuditLog,
  AuditLogDecodeError,
  DEFAULT_WORKSPACE_ID,
  InstallationConfigDecodeError,
  listAuditLog,
  readInstallationConfig,
  writeInstallationConfig,
} from '@/db/repository';
import { decodeKeysetCursor } from '@/domain/pagination';
import {
  AuditValidationError,
  decodeInstallationConfig,
  DEFAULT_INSTALLATION_CONFIG,
  type InstallationConfig,
  InstallationConfigValidationError,
  validateAuditChanges,
  validateAuditWrite,
  validateInstallationConfig,
} from '@/domain/schemas';
import { Effect, Either } from 'effect';
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

  test('migration 0004 creates exactly the three new tables', async () => {
    const fx = await fixture({ through: '0003' });
    const now = Date.now();
    await fx.user({ email: 'bootstrap@example.test', id: 'bootstrap-user' });
    await fx.seedLead('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    await fx.db
      .prepare(
        `INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at)
          VALUES (?, 'bootstrap', 'bootstrap', 'bootstrap', ?, ?)`,
      )
      .bind('claim-1', 'bootstrap-user', now)
      .run();

    await applyMigrationsFrom(fx.db, '0004');

    const tables = await fx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
          'installation_config', 'audit_log', 'notification_preferences',
          'email_settings', 'email_credentials', 'email_settings_permissions',
          'email_settings_audit', 'notification_test_attempts'
        ) ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      'audit_log',
      'installation_config',
      'notification_preferences',
    ]);

    // Existing CRM data and claims survive; no permission backfill exists.
    expect(await fx.count('leads')).toBe(1);
    expect(await fx.count('user')).toBe(1);
    expect(await fx.count('registration_claims')).toBe(1);
    expect(await fx.count('installation_config')).toBe(0);
  });

  test('the configuration document is a validated singleton', async () => {
    const fx = await fixture();
    await fx.enableProvider({ provider: 'resend', revision: 3 });

    expect(await fx.count('installation_config')).toBe(1);
    const stored = await fx.db
      .prepare(
        'SELECT document_json, write_version FROM installation_config WHERE workspace_id = ?',
      )
      .bind(DEFAULT_WORKSPACE_ID)
      .first<{ document_json: string; write_version: number }>();
    const document = decodeInstallationConfig(String(stored?.document_json));
    expect(document?.email.provider).toBe('resend');
    expect(document?.revision).toBe(3);
    expect(Number(stored?.write_version)).toBe(1);

    await expect(
      fx.db
        .prepare(
          `INSERT INTO installation_config (workspace_id, document_json, write_version, write_token)
            VALUES (?, '{}', 1, 'sentinel-token')`,
        )
        .bind(DEFAULT_WORKSPACE_ID)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint/iu);
  });

  test('a corrupt or unsupported document fails closed and is not reset', async () => {
    const fx = await fixture();

    await fx.setRawConfig('not json at all');
    await expect(readInstallationConfig(fx.env)).rejects.toThrow(
      /configuration document is invalid/iu,
    );

    const unsupported: InstallationConfig = {
      ...DEFAULT_INSTALLATION_CONFIG,
      version: 99,
    } as unknown as InstallationConfig;
    await fx.setRawConfig(JSON.stringify(unsupported));
    await expect(readInstallationConfig(fx.env)).rejects.toThrow(
      /configuration document is invalid/iu,
    );

    // The invalid raw document is preserved for operator recovery.
    const row = await fx.readConfigRow();
    expect(row.documentJson).toBe(JSON.stringify(unsupported));
  });

  test('malformed stored JSON fails redacted at the Drizzle read boundary', async () => {
    const fx = await fixture();
    await fx.setRawConfig('{"version":1,"revision":0,"SENTINEL":not-json');

    let configError: unknown;
    try {
      await readInstallationConfig(fx.env);
    } catch (error) {
      configError = error;
    }

    expect(configError).toBeInstanceOf(InstallationConfigDecodeError);
    expect(String(configError)).not.toContain('SENTINEL');

    // An audit row with malformed JSON fails the same way and is not echoed.
    await fx.user({ email: 'audit@example.test', id: 'audit-user' });
    await fx.db
      .prepare(
        `INSERT INTO audit_log (
          id, workspace_id, actor_user_id, created_at, action, resource_type,
          resource_id, changes_json
        ) VALUES ('bad-audit', ?, NULL, ?, 'email.settings_updated',
          'installation.email', NULL, '{AUDIT_SENTINEL')`,
      )
      .bind(DEFAULT_WORKSPACE_ID, Date.now())
      .run();

    let auditError: unknown;
    try {
      await listAuditLog(fx.env, { cursor: null, limit: 10 });
    } catch (error) {
      auditError = error;
    }

    expect(auditError).toBeInstanceOf(AuditLogDecodeError);
    expect(String(auditError)).not.toContain('AUDIT_SENTINEL');
  });

  test('audit helpers append bounded entries and page newest first', async () => {
    const fx = await fixture();
    await fx.user({ email: 'actor@example.test', id: 'audit-actor' });
    const base = Date.now();
    await appendAuditLog(fx.env, {
      actorUserId: 'audit-actor',
      now: new Date(base - 2_000),
      records: [
        {
          action: 'email.settings_updated',
          changes: [
            { after: 'resend', before: 'disabled', field: 'email.provider' },
          ],
          resourceId: null,
          resourceType: 'installation.email',
        },
      ],
    });
    await appendAuditLog(fx.env, {
      actorUserId: null,
      now: new Date(base - 1_000),
      records: [
        {
          action: 'email.test_sent',
          changes: [
            { after: 'accepted', before: 'sending', field: 'test.outcome' },
          ],
          resourceId: null,
          resourceType: 'installation.email_test',
        },
      ],
    });

    const first = await listAuditLog(fx.env, { cursor: null, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      action: 'email.test_sent',
      actorUserId: null,
      changes: [
        { after: 'accepted', before: 'sending', field: 'test.outcome' },
      ],
      resourceType: 'installation.email_test',
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listAuditLog(fx.env, {
      cursor:
        first.nextCursor === null ? null : decodeKeysetCursor(first.nextCursor),
      limit: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      action: 'email.settings_updated',
      actorUserId: 'audit-actor',
    });
  });

  test('audit entries are validated before they reach storage', async () => {
    const fx = await fixture();
    await expect(
      appendAuditLog(fx.env, {
        actorUserId: null,
        now: new Date(),
        records: [
          {
            action: 'Not Bounded',
            changes: [],
            resourceId: null,
            resourceType: 'installation.email',
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await fx.count('audit_log')).toBe(0);
  });

  test('unknown properties at any level are rejected, never stripped', async () => {
    const fx = await fixture();
    const valid: InstallationConfig = {
      ...DEFAULT_INSTALLATION_CONFIG,
      revision: 2,
    };
    const withCredential: InstallationConfig = {
      ...valid,
      email: {
        ...valid.email,
        credential: { ciphertext: 'cipher', keyVersion: 1, nonce: 'nonce' },
        enabled: true,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      },
    };

    const candidates: unknown[] = [
      { ...valid, extra: 'ROOT_SENTINEL' },
      { ...valid, email: { ...valid.email, extra: 'EMAIL_SENTINEL' } },
      {
        ...withCredential,
        email: {
          ...withCredential.email,
          credential: {
            ...withCredential.email.credential,
            extra: 'CREDENTIAL_SENTINEL',
          },
        },
      },
      { ...valid, emailTest: { ...valid.emailTest, extra: 'TEST_SENTINEL' } },
      {
        ...valid,
        emailTest: {
          last: {
            actorUserId: 'actor-1',
            at: 1,
            configRevision: 2,
            extra: 'LAST_SENTINEL',
            outcome: 'accepted',
            provider: 'resend',
            providerMessageId: null,
            reasonCode: null,
            requestId: 'req-1',
          },
          recent: [],
        },
      },
      {
        ...valid,
        emailTest: {
          last: null,
          recent: [{ actorUserId: 'actor-1', at: 1, extra: 'RECENT_SENTINEL' }],
        },
      },
    ];

    for (const candidate of candidates) {
      expect(decodeInstallationConfig(JSON.stringify(candidate))).toBeNull();
      let caught: unknown;
      try {
        validateInstallationConfig(candidate);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InstallationConfigValidationError);
      expect(String(caught)).not.toContain('SENTINEL');
    }

    // Unknown-property candidates must never reach storage.
    await expect(
      writeInstallationConfig(fx.env, {
        actorUserId: null,
        document: {
          ...valid,
          email: { ...valid.email, extra: 'WRITE_SENTINEL' },
        } as unknown as InstallationConfig,
        expectedWriteVersion: 0,
        now: new Date(),
      }),
    ).rejects.toThrow();
    expect(await fx.count('installation_config')).toBe(0);
    expect(await fx.count('audit_log')).toBe(0);
  });

  test('a stored document with unknown fields stays untouched and redacted', async () => {
    const fx = await fixture();
    const invalid = JSON.stringify({
      ...DEFAULT_INSTALLATION_CONFIG,
      email: { ...DEFAULT_INSTALLATION_CONFIG.email, extra: 'ROW_SENTINEL' },
    });
    await fx.setRawConfig(invalid);

    await expect(readInstallationConfig(fx.env)).rejects.toThrow(
      /configuration document is invalid/iu,
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        getEmailSettingsViewCommand(fx.env, 'https://crm.example.test'),
      ),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'config_unavailable' });
    }

    expect(JSON.stringify(outcome)).not.toContain('ROW_SENTINEL');
    expect((await fx.readConfigRow()).documentJson).toBe(invalid);
    expect(await fx.count('audit_log')).toBe(0);
  });

  test('invalid audit candidates fail redacted without echoing values', async () => {
    const fx = await fixture();
    const candidates = [
      {
        action: 'INVALID SENTINEL',
        changes: [],
        resourceId: null,
        resourceType: 'installation.email',
      },
      {
        action: 'email.settings_updated',
        changes: [
          {
            after: null,
            before: { secret: 'AUDIT_SENTINEL' },
            field: 'email.provider',
          },
        ],
        resourceId: null,
        resourceType: 'installation.email',
      },
      {
        action: 'email.settings_updated',
        changes: [],
        extra: 'WRITE_AUDIT_SENTINEL',
        resourceId: null,
        resourceType: 'installation.email',
      },
    ];

    for (const candidate of candidates) {
      let caught: unknown;
      try {
        validateAuditWrite(candidate);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AuditValidationError);
      expect(String(caught)).not.toContain('SENTINEL');
    }

    expect(() =>
      validateAuditChanges([
        {
          after: null,
          before: 'CHANGES_SENTINEL',
          extra: 'CHANGES_EXTRA_SENTINEL',
          field: 'email.provider',
        } as never,
      ]),
    ).toThrow(AuditValidationError);

    await expect(
      appendAuditLog(fx.env, {
        actorUserId: null,
        now: new Date(),
        records: candidates as never,
      }),
    ).rejects.toThrow();
    expect(await fx.count('audit_log')).toBe(0);
  });
});
