import {
  type NotificationFixture,
  startNotificationFixture,
  TEST_ENCRYPTION_KEY,
} from './notification-fixture';
import {
  getEmailSettingsView,
  loadEmailSettingsState,
  sendTestEmailCommand,
  updateEmailSettingsCommand,
} from '@/application/notification-commands';
import {
  getEmailCredential,
  getEmailSettings,
  getNotificationTestAttempt,
  grantEmailSettingsPermission,
  hasAnyEmailSettingsPermission,
  hasEmailSettingsPermission,
  saveEmailSettings,
} from '@/db/repository';
import { decryptCredential } from '@/notifications/credential-crypto';
import { type FetchLike } from '@/notifications/providers/resend';
import { Effect, Either } from 'effect';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ADMIN_ID = 'settings-admin';
const SETTINGS_ORIGIN = 'https://crm.example.test';

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  await fixture.user({ email: 'admin@example.test', id: ADMIN_ID });
});

afterEach(async () => {
  await fixture.dispose();
});

const run = async <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.either(effect));

const saveInput = (
  expectedRevision: number,
  overrides: Partial<Parameters<typeof saveEmailSettings>[1]> = {},
) => ({
  actorUserId: ADMIN_ID,
  canonicalOrigin: SETTINGS_ORIGIN,
  credentialChange: { operation: 'keep' as const },
  enabled: true,
  expectedRevision,
  fromEmail: 'notifications@example.test',
  fromName: 'LeadScroll',
  now: new Date(),
  provider: 'cloudflare' as const,
  ...overrides,
});

const acceptedFetch =
  (messageId = 're-1'): FetchLike =>
  async () =>
    Response.json({ id: messageId });

const transportFailure = (): FetchLike => async () => {
  throw new Error('timeout');
};

describe('installation email settings persistence', () => {
  test('allocates server revisions with compare-and-swap and audit rows', async () => {
    const created = await saveEmailSettings(
      fixture.env,
      saveInput(0, { credentialChange: { operation: 'keep' } }),
    );
    expect(created.kind).toBe('saved');
    if (created.kind !== 'saved') {
      return;
    }

    expect(created.settings.revision).toBe(1);
    const updated = await saveEmailSettings(
      fixture.env,
      saveInput(1, {
        enabled: false,
        fromName: 'Renamed',
      }),
    );
    expect(updated.kind).toBe('saved');
    if (updated.kind === 'saved') {
      expect(updated.settings.revision).toBe(2);
      expect(updated.settings.enabled).toBe(false);
      expect(updated.settings.fromName).toBe('Renamed');
    }

    const stale = await saveEmailSettings(fixture.env, saveInput(1));
    expect(stale.kind).toBe('conflict');
    expect((await getEmailSettings(fixture.env))?.revision).toBe(2);

    const audit = await fixture.db
      .prepare(
        'SELECT action, revision FROM email_settings_audit ORDER BY revision',
      )
      .all<{ action: string; revision: number }>();
    expect(audit.results).toEqual([
      { action: 'settings_saved', revision: 1 },
      { action: 'settings_saved', revision: 2 },
    ]);
  });

  test('a concurrent compare-and-swap loser leaves no credential or audit writes', async () => {
    await saveEmailSettings(fixture.env, saveInput(0));
    const { encryptCredential } =
      await import('@/notifications/credential-crypto');
    const [first, second] = await Promise.all([
      saveEmailSettings(
        fixture.env,
        saveInput(1, {
          credentialChange: {
            envelope: await encryptCredential(TEST_ENCRYPTION_KEY, {
              provider: 'resend',
              value: 're_first',
              workspaceId: WORKSPACE,
            }),
            operation: 'replace',
          },
          provider: 'resend',
        }),
      ),
      saveEmailSettings(
        fixture.env,
        saveInput(1, {
          credentialChange: {
            envelope: await encryptCredential(TEST_ENCRYPTION_KEY, {
              provider: 'resend',
              value: 're_second',
              workspaceId: WORKSPACE,
            }),
            operation: 'replace',
          },
          provider: 'resend',
        }),
      ),
    ]);
    const kinds = [first.kind, second.kind].toSorted();
    expect(kinds).toEqual(['conflict', 'saved']);
    expect((await getEmailSettings(fixture.env))?.revision).toBe(2);
    expect(await fixture.count('email_credentials')).toBe(1);
    expect(await fixture.count('email_settings_audit')).toBe(2);
  });

  test('stores credentials encrypted and removing the active key disables the provider', async () => {
    const { encryptCredential } =
      await import('@/notifications/credential-crypto');
    const envelope = await encryptCredential(TEST_ENCRYPTION_KEY, {
      provider: 'resend',
      value: 're_secret',
      workspaceId: WORKSPACE,
    });
    await saveEmailSettings(fixture.env, saveInput(0));
    await saveEmailSettings(
      fixture.env,
      saveInput(1, {
        credentialChange: { envelope, operation: 'replace' },
        provider: 'resend',
      }),
    );

    const stored = await getEmailCredential(fixture.env, 'resend');
    expect(stored?.ciphertext).not.toContain('re_secret');
    if (stored === null) {
      throw new Error('The credential was not stored.');
    }

    await expect(
      decryptCredential(TEST_ENCRYPTION_KEY, {
        envelope: {
          ciphertext: stored.ciphertext,
          keyVersion: stored.keyVersion,
          nonce: stored.nonce,
        },
        provider: 'resend',
        workspaceId: WORKSPACE,
      }),
    ).resolves.toBe('re_secret');

    const removed = await saveEmailSettings(
      fixture.env,
      saveInput(2, {
        credentialChange: { operation: 'remove' },
        enabled: true,
        provider: 'resend',
      }),
    );
    expect(removed.kind).toBe('saved');
    if (removed.kind === 'saved') {
      expect(removed.settings.provider).toBe('disabled');
      expect(removed.settings.enabled).toBe(false);
    }

    expect(await getEmailCredential(fixture.env, 'resend')).toBeNull();
  });

  test('the settings command fails closed without a usable encryption key', async () => {
    fixture.setEncryptionKey(undefined);
    const missing = await run(
      updateEmailSettingsCommand(fixture.env, {
        actorUserId: ADMIN_ID,
        canonicalOrigin: SETTINGS_ORIGIN,
        credential: { operation: 'replace', value: 're_key' },
        enabled: true,
        expectedRevision: 0,
        fromEmail: 'notifications@example.test',
        fromName: null,
        provider: 'resend',
      }),
    );
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) {
      expect(missing.left).toMatchObject({ code: 'encryption_key_missing' });
    }

    expect(await getEmailSettings(fixture.env)).toBeNull();

    fixture.setEncryptionKey('not-a-valid-key');
    const invalid = await run(
      updateEmailSettingsCommand(fixture.env, {
        actorUserId: ADMIN_ID,
        canonicalOrigin: SETTINGS_ORIGIN,
        credential: { operation: 'replace', value: 're_key' },
        enabled: true,
        expectedRevision: 0,
        fromEmail: 'notifications@example.test',
        fromName: null,
        provider: 'resend',
      }),
    );
    expect(Either.isLeft(invalid)).toBe(true);
    if (Either.isLeft(invalid)) {
      expect(invalid.left).toMatchObject({ code: 'encryption_key_invalid' });
    }

    expect(await getEmailSettings(fixture.env)).toBeNull();
  });

  test('saving and enabling never sends and never requires test evidence', async () => {
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'unused' }),
    });
    const result = await run(
      updateEmailSettingsCommand(fixture.env, {
        actorUserId: ADMIN_ID,
        canonicalOrigin: SETTINGS_ORIGIN,
        credential: { operation: 'keep' },
        enabled: true,
        expectedRevision: 0,
        fromEmail: 'notifications@example.test',
        fromName: 'LeadScroll',
        provider: 'cloudflare',
      }),
    );
    expect(Either.isRight(result)).toBe(true);
    expect(await fixture.count('notification_test_attempts')).toBe(0);

    const view = await getEmailSettingsView(fixture.env, SETTINGS_ORIGIN);
    expect(view.enabled).toBe(true);
    expect(view.test).toBeNull();
    expect(view.revision).toBe(1);
  });

  test('exposes readiness and redacted credential presence', async () => {
    await saveEmailSettings(fixture.env, saveInput(0, { provider: 'resend' }));
    const misconfigured = await getEmailSettingsView(
      fixture.env,
      SETTINGS_ORIGIN,
    );
    expect(misconfigured.readiness).toEqual({
      availability: 'misconfigured',
      reasonCode: 'resend_api_key_missing',
    });
    expect(misconfigured.hasApiKey).toBe(false);

    await fixture.insertCredential('re_hidden');
    const configured = await getEmailSettingsView(fixture.env, SETTINGS_ORIGIN);
    expect(configured.readiness.availability).toBe('configured');
    expect(configured.hasApiKey).toBe(true);
    const serialized = JSON.stringify(configured);
    expect(serialized).not.toContain('re_hidden');
    expect(serialized).not.toContain('ciphertext');
  });

  test('a disabled installation switch is reported as disabled, not unavailable', async () => {
    await fixture.enableProvider({
      enabled: false,
      provider: 'cloudflare',
      revision: 3,
    });
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'stub' }),
    });

    const state = await loadEmailSettingsState(fixture.env);
    expect(state.availability).toBe('disabled');
    const view = await getEmailSettingsView(fixture.env, SETTINGS_ORIGIN);
    expect(view.enabled).toBe(false);
  });
});

describe('administrator test email command', () => {
  const testInput = (requestId: string, expectedRevision = 1) => ({
    actorEmail: 'admin@example.test',
    actorUserId: ADMIN_ID,
    canonicalOrigin: SETTINGS_ORIGIN,
    expectedRevision,
    requestId,
  });

  const configuredResend = async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_test_key');
  };

  test('sends one attempt, never targets another recipient, and is idempotent by request id', async () => {
    await configuredResend();
    const calls: Array<{ body: unknown; key: string; to: string }> = [];
    const fetchMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string[] };
      calls.push({
        body,
        key: String(
          (init?.headers as Record<string, string>)['Idempotency-Key'],
        ),
        to: body.to[0],
      });
      return Response.json({ id: 're-test-1' });
    };

    const first = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-1'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isRight(first)).toBe(true);
    if (Either.isRight(first)) {
      expect(first.right).toMatchObject({ outcome: 'accepted', revision: 1 });
    }

    const replay = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-1'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isRight(replay)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('admin@example.test');
    expect(calls[0].key).toBe('leadscroll-email-test:test-req-1');
  });

  test('an ambiguous attempt is reported honestly and never automatically retried', async () => {
    await configuredResend();
    const fetchMock = vi.fn<FetchLike>(transportFailure());
    const t0 = Date.now();
    const first = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-2'), {
        fetchImplementation: fetchMock,
        now: () => new Date(t0),
      }),
    );
    expect(Either.isRight(first)).toBe(true);
    if (Either.isRight(first)) {
      expect(first.right.outcome).toBe('ambiguous');
    }

    // The same request id is an idempotent response, not a retry.
    const sameId = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-2'), {
        fetchImplementation: fetchMock,
        now: () => new Date(t0 + 30_000),
      }),
    );
    expect(Either.isRight(sameId)).toBe(true);
    if (Either.isRight(sameId)) {
      expect(sameId.right.outcome).toBe('ambiguous');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A new explicit test after the rate window is a new attempt.
    const fresh = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-2b'), {
        fetchImplementation: acceptedFetch('re-fresh'),
        now: () => new Date(t0 + 61_000),
      }),
    );
    expect(Either.isRight(fresh)).toBe(true);
    if (Either.isRight(fresh)) {
      expect(fresh.right.outcome).toBe('accepted');
    }
  });

  test('concurrent sends with the same request id emit one message', async () => {
    await configuredResend();
    const calls: string[] = [];
    const fetchMock: FetchLike = async (_url, init) => {
      calls.push(
        String((init?.headers as Record<string, string>)['Idempotency-Key']),
      );
      return Response.json({ id: 're-concurrent' });
    };

    const [first, second] = await Promise.all([
      run(
        sendTestEmailCommand(fixture.env, testInput('test-concurrent'), {
          fetchImplementation: fetchMock,
        }),
      ),
      run(
        sendTestEmailCommand(fixture.env, testInput('test-concurrent'), {
          fetchImplementation: fetchMock,
        }),
      ),
    ]);
    expect(Either.isRight(first)).toBe(true);
    expect(Either.isRight(second)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('leadscroll-email-test:test-concurrent');
    expect(await fixture.count('notification_test_attempts')).toBe(1);
  });

  test('enforces one per minute and five per day per installation', async () => {
    await configuredResend();
    const fetchMock = vi.fn<FetchLike>(acceptedFetch());
    const start = Date.now();

    for (let index = 0; index < 5; index += 1) {
      const outcome = await run(
        sendTestEmailCommand(fixture.env, testInput(`test-limit-${index}`), {
          fetchImplementation: fetchMock,
          now: () => new Date(start + index * 61_000),
        }),
      );
      expect(Either.isRight(outcome)).toBe(true);
    }

    const tooFast = await run(
      sendTestEmailCommand(fixture.env, testInput('test-fast'), {
        fetchImplementation: fetchMock,
        now: () => new Date(start + 4 * 61_000 + 10_000),
      }),
    );
    expect(Either.isLeft(tooFast)).toBe(true);
    if (Either.isLeft(tooFast)) {
      expect(tooFast.left).toMatchObject({ code: 'test_rate_limited' });
    }

    const overDaily = await run(
      sendTestEmailCommand(fixture.env, testInput('test-daily'), {
        fetchImplementation: fetchMock,
        now: () => new Date(start + 5 * 61_000),
      }),
    );
    expect(Either.isLeft(overDaily)).toBe(true);
    if (Either.isLeft(overDaily)) {
      expect(overDaily.left).toMatchObject({ code: 'test_daily_limited' });
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('a decryption failure records a configuration error without contacting the provider', async () => {
    await configuredResend();
    await fixture.db
      .prepare(
        "UPDATE email_credentials SET ciphertext = 'not-a-valid-envelope' WHERE workspace_id = ?",
      )
      .bind(WORKSPACE)
      .run();
    const fetchMock = vi.fn<FetchLike>(acceptedFetch());

    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-bad-key'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.outcome).toBe('configuration_error');
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (await getNotificationTestAttempt(fixture.env, 'test-req-bad-key'))
        ?.reasonCode,
    ).toBe('decrypt_failed');
    // A configuration failure never pauses the installation.
    expect(await getEmailSettings(fixture.env)).toMatchObject({
      enabled: true,
      provider: 'resend',
    });
  });

  test('rejects a stale settings revision before reserving anything', async () => {
    await configuredResend();
    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-6', 99)),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'revision_conflict' });
    }

    expect(await fixture.count('notification_test_attempts')).toBe(0);
  });

  test('another actor request id is a conflict that never sends or leaks', async () => {
    await configuredResend();
    await fixture.user({
      email: 'someone-else@example.test',
      id: 'someone-else',
    });
    const now = Date.now();
    await fixture.db
      .prepare(
        `INSERT INTO notification_test_attempts (
          id, workspace_id, user_id, config_revision, provider, status,
          created_at, updated_at
        ) VALUES (?, ?, 'someone-else', 1, 'resend', 'ambiguous', ?, ?)`,
      )
      .bind('foreign-request', WORKSPACE, now, now)
      .run();

    const fetchCalls: string[] = [];
    const fetchMock: FetchLike = async () => {
      fetchCalls.push('called');
      return Response.json({ id: 're-must-not-send' });
    };

    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('foreign-request'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'test_request_conflict' });
    }

    expect(fetchCalls).toHaveLength(0);
    const foreign = await getNotificationTestAttempt(
      fixture.env,
      'foreign-request',
    );
    expect(foreign?.status).toBe('ambiguous');
    expect(foreign?.providerMessageId).toBeNull();
  });

  test('a notifications-off installation can still run an explicit test', async () => {
    await configuredResend();
    const t0 = Date.now();
    const disabledSettings = await saveEmailSettings(
      fixture.env,
      saveInput(1, {
        credentialChange: { operation: 'keep' },
        enabled: false,
        provider: 'resend',
      }),
    );
    expect(disabledSettings.kind).toBe('saved');
    const fetchMock = vi.fn<FetchLike>(acceptedFetch('re-disabled-ok'));
    const disabledTest = await run(
      sendTestEmailCommand(fixture.env, testInput('notifications-off', 2), {
        fetchImplementation: fetchMock,
        now: () => new Date(t0),
      }),
    );
    expect(Either.isRight(disabledTest)).toBe(true);
    expect((await getEmailSettings(fixture.env))?.enabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('manageEmailSettings capability', () => {
  test('grants only to explicit enabled accounts and is idempotent', async () => {
    expect(await hasAnyEmailSettingsPermission(fixture.env)).toBe(false);
    expect(
      await grantEmailSettingsPermission(fixture.env, 'missing-user'),
    ).toBe('not-found');

    const disabledId = 'disabled-admin';
    await fixture.user({
      disabled: true,
      email: 'off@example.test',
      id: disabledId,
    });
    expect(await grantEmailSettingsPermission(fixture.env, disabledId)).toBe(
      'disabled',
    );

    expect(await grantEmailSettingsPermission(fixture.env, ADMIN_ID)).toBe(
      'granted',
    );
    expect(await grantEmailSettingsPermission(fixture.env, ADMIN_ID)).toBe(
      'granted',
    );
    expect(await hasEmailSettingsPermission(fixture.env, ADMIN_ID)).toBe(true);
    expect(await hasEmailSettingsPermission(fixture.env, disabledId)).toBe(
      false,
    );
    expect(await fixture.count('email_settings_permissions')).toBe(1);
  });
});
