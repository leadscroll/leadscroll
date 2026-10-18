import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  makeNotificationRuntime,
  manualClock,
  recordingProvider,
  recordingResolver,
  runEffect,
  runEither,
} from './notification-services';
import {
  getEmailSettingsViewCommand,
  updateEmailSettingsCommand,
} from '@/application/notification-settings';
import { sendTestEmailCommand } from '@/application/notification-test-send';
import { appendAuditLog } from '@/db/repository';
import { decodeAuditChanges, decodeInstallationConfig } from '@/domain/schemas';
import { Deferred, Effect, Either } from 'effect';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ADMIN_ID = 'settings-admin';
const OTHER_ID = 'settings-other';
const SETTINGS_ORIGIN = 'https://crm.example.test';

let fixture: NotificationFixture;

beforeEach(async () => {
  fixture = await startNotificationFixture();
  await fixture.user({ email: 'admin@example.test', id: ADMIN_ID });
  await fixture.user({ email: 'other@example.test', id: OTHER_ID });
});

afterEach(async () => {
  await fixture.dispose();
  vi.restoreAllMocks();
});

const saveInput = (
  expectedRevision: number,
  overrides: {
    actorUserId?: string;
    credential?:
      | { operation: 'keep' }
      | { operation: 'remove' }
      | { operation: 'replace'; value: string };
    enabled?: boolean;
    fromEmail?: null | string;
    fromName?: null | string;
    provider?: 'cloudflare' | 'disabled' | 'resend';
  } = {},
) => ({
  actorUserId: overrides.actorUserId ?? ADMIN_ID,
  canonicalOrigin: SETTINGS_ORIGIN,
  credential: overrides.credential ?? { operation: 'keep' as const },
  enabled: overrides.enabled ?? true,
  expectedRevision,
  fromEmail:
    overrides.fromEmail === undefined
      ? 'notifications@example.test'
      : overrides.fromEmail,
  fromName:
    overrides.fromName === undefined ? 'LeadScroll' : overrides.fromName,
  provider: overrides.provider ?? ('resend' as const),
});

const testInput = (requestId: string, expectedRevision = 1) => ({
  actorEmail: 'admin@example.test',
  actorUserId: ADMIN_ID,
  canonicalOrigin: SETTINGS_ORIGIN,
  expectedRevision,
  requestId,
});

const configuredResend = async (revision = 1) => {
  await fixture.enableProvider({
    credential: 're_original_key',
    provider: 'resend',
    revision,
  });
  return revision;
};

const readDocument = async () => fixture.readConfig();

describe('installation configuration persistence', () => {
  test('creates revision 1 with a redacted audit entry and reloads the view', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    const saved = await runEither(
      runtime,
      updateEmailSettingsCommand(
        saveInput(0, {
          credential: { operation: 'replace', value: 're_first_key' },
          provider: 'resend',
        }),
      ),
    );
    expect(Either.isRight(saved)).toBe(true);
    if (Either.isRight(saved)) {
      expect(saved.right).toMatchObject({
        enabled: true,
        hasApiKey: true,
        provider: 'resend',
        revision: 1,
      });
    }

    const document = await readDocument();
    expect(document.revision).toBe(1);
    expect(document.email.credential).not.toBeNull();
    expect(JSON.stringify(document)).not.toContain('re_first_key');

    const rows = await fixture.readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'email.settings_updated',
      actorUserId: ADMIN_ID,
      resourceType: 'installation.email',
    });
    const changes = decodeAuditChanges(JSON.parse(rows[0].changesJson));
    expect(changes).toEqual(
      expect.arrayContaining([
        { after: 'resend', before: 'disabled', field: 'email.provider' },
        { after: 'stored', before: null, field: 'email.credential' },
      ]),
    );
    expect(rows[0].changesJson).not.toContain('re_first_key');
    expect(rows[0].changesJson).not.toContain('ciphertext');

    const view = await runEffect(
      runtime,
      getEmailSettingsViewCommand(SETTINGS_ORIGIN),
    );
    expect(view.revision).toBe(1);
    expect(JSON.stringify(view)).not.toContain('re_first_key');
    expect(JSON.stringify(view)).not.toContain('ciphertext');
  });

  test('a stale revision conflicts and a lost CAS race leaves no audit entry', async () => {
    await fixture.enableProvider({ provider: 'cloudflare', revision: 2 });
    const runtime = makeNotificationRuntime(fixture.env);
    const stale = await runEither(
      runtime,
      updateEmailSettingsCommand(saveInput(1)),
    );
    expect(Either.isLeft(stale)).toBe(true);
    if (Either.isLeft(stale)) {
      expect(stale.left).toMatchObject({ code: 'revision_conflict' });
    }

    expect(await fixture.readAuditRows()).toHaveLength(0);

    // Two concurrent saves from the same revision: exactly one wins and the
    // loser's attempted audit is never written.
    const outcomes = await runtime.runPromise(
      Effect.all(
        [
          Effect.either(updateEmailSettingsCommand(saveInput(2))),
          Effect.either(
            updateEmailSettingsCommand(
              saveInput(2, { actorUserId: OTHER_ID, fromName: 'Second' }),
            ),
          ),
        ],
        { concurrency: 2 },
      ),
    );
    const rights = outcomes.filter((outcome) => Either.isRight(outcome));
    const lefts = outcomes.filter((outcome) => Either.isLeft(outcome));
    expect(rights).toHaveLength(1);
    expect(lefts).toHaveLength(1);

    expect(await fixture.readAuditRows()).toHaveLength(1);
    expect((await readDocument()).revision).toBe(3);
  });

  test('stores the credential encrypted and records remove/replace markers', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    await runEffect(
      runtime,
      updateEmailSettingsCommand(
        saveInput(0, {
          credential: { operation: 'replace', value: 're_secret_key' },
        }),
      ),
    );
    const stored = await readDocument();
    expect(stored.email.credential?.ciphertext).not.toContain('re_secret_key');

    await runEffect(
      runtime,
      updateEmailSettingsCommand(
        saveInput(1, {
          credential: { operation: 'replace', value: 're_replaced_key' },
        }),
      ),
    );
    await runEffect(
      runtime,
      updateEmailSettingsCommand(
        saveInput(2, {
          credential: { operation: 'remove' },
          provider: 'resend',
        }),
      ),
    );

    const rows = await fixture.readAuditRows();
    const markers = rows.flatMap(
      (row) =>
        decodeAuditChanges(JSON.parse(row.changesJson))
          ?.filter((change) => change.field === 'email.credential')
          .map((change) => [change.before, change.after]) ?? [],
    );
    expect(markers).toEqual([
      [null, 'stored'],
      ['stored', 'replaced'],
      ['stored', 'removed'],
    ]);
    const removed = await readDocument();
    expect(removed.email.credential).toBeNull();
    expect(removed.email.provider).toBe('disabled');
    expect(removed.email.enabled).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('re_secret_key');
    expect(JSON.stringify(rows)).not.toContain('re_replaced_key');
  });

  test('fails closed without a usable encryption key and writes nothing', async () => {
    fixture.setEncryptionKey(undefined);
    const missingRuntime = makeNotificationRuntime(fixture.env);
    const missing = await runEither(
      missingRuntime,
      updateEmailSettingsCommand(
        saveInput(0, { credential: { operation: 'replace', value: 're_key' } }),
      ),
    );
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) {
      expect(missing.left).toMatchObject({ code: 'encryption_key_missing' });
    }

    fixture.setEncryptionKey('not-a-valid-key');
    const invalidRuntime = makeNotificationRuntime(fixture.env);
    const invalid = await runEither(
      invalidRuntime,
      updateEmailSettingsCommand(
        saveInput(0, { credential: { operation: 'replace', value: 're_key' } }),
      ),
    );
    expect(Either.isLeft(invalid)).toBe(true);
    if (Either.isLeft(invalid)) {
      expect(invalid.left).toMatchObject({ code: 'encryption_key_invalid' });
    }

    expect(await fixture.count('installation_config')).toBe(0);
    expect(await fixture.readAuditRows()).toHaveLength(0);
  });

  test('a corrupt document fails settings routes closed and is preserved', async () => {
    await fixture.setRawConfig('{ not valid json', 4);
    const rawBefore = await fixture.readConfigRow();
    const runtime = makeNotificationRuntime(fixture.env);

    const view = await runEither(
      runtime,
      getEmailSettingsViewCommand(SETTINGS_ORIGIN),
    );
    expect(Either.isLeft(view)).toBe(true);
    if (Either.isLeft(view)) {
      expect(view.left).toMatchObject({ code: 'config_unavailable' });
    }

    const saved = await runEither(
      runtime,
      updateEmailSettingsCommand(saveInput(0)),
    );
    expect(Either.isLeft(saved)).toBe(true);
    if (Either.isLeft(saved)) {
      expect(saved.left).toMatchObject({ code: 'config_unavailable' });
    }

    expect((await fixture.readConfigRow()).documentJson).toBe(
      rawBefore.documentJson,
    );
    expect(await fixture.readAuditRows()).toHaveLength(0);
  });

  test('exposes readiness and redacted credential presence', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    await fixture.enableProvider({ provider: 'resend' });
    const misconfigured = await runEffect(
      runtime,
      getEmailSettingsViewCommand(SETTINGS_ORIGIN),
    );
    expect(misconfigured.readiness).toEqual({
      availability: 'misconfigured',
      reasonCode: 'resend_api_key_missing',
    });
    expect(misconfigured.hasApiKey).toBe(false);

    await fixture.insertCredential('re_hidden');
    const configured = await runEffect(
      runtime,
      getEmailSettingsViewCommand(SETTINGS_ORIGIN),
    );
    expect(configured.readiness.availability).toBe('configured');
    expect(configured.hasApiKey).toBe(true);
    const serialized = JSON.stringify(configured);
    expect(serialized).not.toContain('re_hidden');
    expect(serialized).not.toContain('ciphertext');
  });

  test('a disabled installation switch is reported as disabled', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    await fixture.enableProvider({ enabled: false, provider: 'cloudflare' });
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'stub' }),
    });

    const view = await runEffect(
      runtime,
      getEmailSettingsViewCommand(SETTINGS_ORIGIN),
    );
    expect(view.enabled).toBe(false);
    expect(view.readiness.availability).toBe('disabled');
  });

  test('a settings no-op records an empty audit change set', async () => {
    await fixture.enableProvider({ provider: 'cloudflare', revision: 1 });
    const runtime = makeNotificationRuntime(fixture.env);
    await runEffect(
      runtime,
      updateEmailSettingsCommand(saveInput(1, { provider: 'cloudflare' })),
    );

    const rows = await fixture.readAuditRows();
    expect(rows).toHaveLength(1);
    expect(decodeAuditChanges(JSON.parse(rows[0].changesJson))).toEqual([]);
  });
});

describe('administrator test email command', () => {
  test('sends once, keeps the settings revision, and audits the outcome', async () => {
    await configuredResend();
    const { calls, provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-test-1',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );

    const first = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-1')),
    );
    expect(Either.isRight(first)).toBe(true);
    if (Either.isRight(first)) {
      expect(first.right).toMatchObject({ outcome: 'accepted', revision: 1 });
    }

    const document = await readDocument();
    expect(document.revision).toBe(1);
    expect(document.emailTest.last).toMatchObject({
      actorUserId: ADMIN_ID,
      configRevision: 1,
      outcome: 'accepted',
      requestId: 'test-req-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].deliveryKey).toBe('leadscroll-email-test:test-req-1');
    expect(calls[0].envelope.to).toBe('admin@example.test');

    const rows = await fixture.readAuditRows();
    const testRows = rows.filter((row) => row.action === 'email.test_sent');
    expect(testRows).toHaveLength(1);
    expect(testRows[0].actorUserId).toBe(ADMIN_ID);

    // The same request id is an idempotent response, not a second send.
    const replay = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-1')),
    );
    expect(Either.isRight(replay)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('an ambiguous outcome is honest and is never automatically retried', async () => {
    await configuredResend();
    const t0 = Date.now();
    const clock = manualClock(t0);
    const { calls, provider } = recordingProvider({
      kind: 'ambiguous',
      provider: 'resend',
      reason: 'transport_error',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
      clock.layer,
    );

    const first = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-2')),
    );
    expect(Either.isRight(first)).toBe(true);
    if (Either.isRight(first)) {
      expect(first.right.outcome).toBe('ambiguous');
    }

    clock.set(t0 + 30_000);
    const sameId = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-2')),
    );
    expect(Either.isRight(sameId)).toBe(true);
    if (Either.isRight(sameId)) {
      expect(sameId.right.outcome).toBe('ambiguous');
    }

    expect(calls).toHaveLength(1);

    const accepted = recordingProvider({
      kind: 'accepted',
      messageId: 're-fresh',
      provider: 'resend',
    });
    const freshRuntime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(accepted.provider),
      clock.layer,
    );
    clock.set(t0 + 61_000);
    const fresh = await runEither(
      freshRuntime,
      sendTestEmailCommand(testInput('test-req-2b')),
    );
    expect(Either.isRight(fresh)).toBe(true);
    if (Either.isRight(fresh)) {
      expect(fresh.right.outcome).toBe('accepted');
    }
  });

  test('concurrent sends with the same request id emit one message', async () => {
    await configuredResend();
    const { calls, provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-concurrent',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );

    const outcomes = await runtime.runPromise(
      Effect.all(
        [
          Effect.either(sendTestEmailCommand(testInput('test-concurrent'))),
          Effect.either(sendTestEmailCommand(testInput('test-concurrent'))),
        ],
        { concurrency: 2 },
      ),
    );
    expect(outcomes.every(Either.isRight)).toBe(true);
    expect(calls).toHaveLength(1);
    const document = await readDocument();
    expect(document.emailTest.recent).toHaveLength(1);
    expect(document.emailTest.last?.outcome).toBe('accepted');
  });

  test('enforces one per minute and five per rolling 24 hours', async () => {
    await configuredResend();
    const t0 = Date.now();
    const clock = manualClock(t0);
    const { calls, provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-limit',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
      clock.layer,
    );

    for (let index = 0; index < 5; index += 1) {
      const outcome = await runEither(
        runtime,
        sendTestEmailCommand(testInput(`test-limit-${index}`)),
      );
      expect(Either.isRight(outcome)).toBe(true);
      clock.advance(61_000);
    }

    clock.set(t0 + 4 * 61_000 + 10_000);
    const tooFast = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-fast')),
    );
    expect(Either.isLeft(tooFast)).toBe(true);
    if (Either.isLeft(tooFast)) {
      expect(tooFast.left).toMatchObject({ code: 'test_rate_limited' });
    }

    clock.set(t0 + 5 * 61_000);
    const overDaily = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-daily')),
    );
    expect(Either.isLeft(overDaily)).toBe(true);
    if (Either.isLeft(overDaily)) {
      expect(overDaily.left).toMatchObject({ code: 'test_daily_limited' });
    }

    expect(calls).toHaveLength(5);

    // The rolling window prunes after 24 hours and the bounded array stays at
    // the small window size instead of growing without limit.
    clock.set(t0 + 5 * 61_000 + 24 * 60 * 60 * 1_000);
    const nextDay = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-next-day')),
    );
    expect(Either.isRight(nextDay)).toBe(true);
    const document = await readDocument();
    expect(document.emailTest.recent).toHaveLength(1);
  });

  test('a decryption failure records a configuration error without sending', async () => {
    await configuredResend();
    await fixture.db
      .prepare(
        "UPDATE installation_config SET document_json = json_set(document_json, '$.email.credential.ciphertext', 'not-a-valid-envelope') WHERE id = 1",
      )
      .run();
    const runtime = makeNotificationRuntime(fixture.env);

    const outcome = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-bad-key')),
    );
    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.outcome).toBe('configuration_error');
    }

    const document = await readDocument();
    expect(document.emailTest.last).toMatchObject({
      outcome: 'configuration_error',
      reasonCode: 'decrypt_failed',
    });
    // A configuration failure never changes the user-visible revision.
    expect(document.revision).toBe(1);
  });

  test('rejects a stale settings revision before reserving anything', async () => {
    await configuredResend();
    const runtime = makeNotificationRuntime(fixture.env);
    const outcome = await runEither(
      runtime,
      sendTestEmailCommand(testInput('test-req-stale', 99)),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'revision_conflict' });
    }

    expect((await readDocument()).emailTest.last).toBeNull();
  });

  test("another actor's request id is a conflict that never sends or leaks", async () => {
    await configuredResend();
    const { provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-other',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const first = await runEither(
      runtime,
      sendTestEmailCommand({
        ...testInput('foreign-request'),
        actorEmail: 'other@example.test',
        actorUserId: OTHER_ID,
      }),
    );
    expect(Either.isRight(first)).toBe(true);
    const before = await readDocument();

    const outcome = await runEither(
      runtime,
      sendTestEmailCommand(testInput('foreign-request')),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'test_request_conflict' });
    }

    expect((await readDocument()).emailTest.last).toEqual(
      before.emailTest.last,
    );
  });

  test('two actors racing the same request id never receive the other actor data', async () => {
    await configuredResend();
    const t0 = Date.now();
    const clock = manualClock(t0);
    const { calls, provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-race',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
      clock.layer,
    );

    for (let index = 0; index < 5; index += 1) {
      const requestId = `race-request-${index}`;
      const outcomes = await runtime.runPromise(
        Effect.all(
          [
            Effect.either(sendTestEmailCommand(testInput(requestId))),
            Effect.either(
              sendTestEmailCommand({
                ...testInput(requestId),
                actorEmail: 'other@example.test',
                actorUserId: OTHER_ID,
              }),
            ),
          ],
          { concurrency: 2 },
        ),
      );

      const accepted: number[] = [];
      const conflicts: string[] = [];
      for (const outcome of outcomes) {
        if (Either.isRight(outcome) && outcome.right.outcome === 'accepted') {
          accepted.push(1);
        }

        if (Either.isLeft(outcome)) {
          const left = outcome.left as { code?: string };
          if (left.code === 'test_request_conflict') {
            conflicts.push(left.code);
          }
        }
      }

      expect(accepted).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      clock.advance(61_000);
    }

    expect(calls).toHaveLength(5);
  });

  test('a late completion never returns a concurrent reservation to the slower actor', async () => {
    await configuredResend();
    const t0 = Date.now();
    const clock = manualClock(t0);
    const gate = Effect.runSync(Deferred.make<boolean>());
    // Only A's send is gated; B's concurrent send resolves immediately.
    const { calls, provider } = recordingProvider((_input, call) =>
      call === 0
        ? Deferred.await(gate).pipe(
            Effect.as({
              kind: 'accepted' as const,
              messageId: 're-a',
              provider: 'resend' as const,
            }),
          )
        : Effect.succeed({
            kind: 'accepted' as const,
            messageId: 're-b',
            provider: 'resend' as const,
          }),
    );
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
      clock.layer,
    );

    const aOutcomePromise = runEither(
      runtime,
      sendTestEmailCommand(testInput('late-request-a')),
    );

    // Wait until A has reserved, then let B reserve and finish at t0 + 61s.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reserved = await readDocument();
      if (reserved.emailTest.last?.requestId === 'late-request-a') {
        break;
      }

      if (Date.now() > deadline) {
        throw new Error('The A reservation was never written.');
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    clock.set(t0 + 61_000);
    const bOutcome = await runEither(
      runtime,
      sendTestEmailCommand({
        ...testInput('late-request-b'),
        actorEmail: 'other@example.test',
        actorUserId: OTHER_ID,
      }),
    );
    expect(Either.isRight(bOutcome)).toBe(true);
    if (Either.isRight(bOutcome)) {
      expect(bOutcome.right.outcome).toBe('accepted');
    }

    Effect.runSync(Deferred.succeed(gate, true));
    const aOutcome = await aOutcomePromise;
    // A's reservation was replaced by B. A gets a safe conflict, never B's
    // accepted result.
    expect(Either.isLeft(aOutcome)).toBe(true);
    if (Either.isLeft(aOutcome)) {
      expect(aOutcome.left).toMatchObject({ code: 'test_request_conflict' });
    }

    expect(aOutcome).not.toMatchObject({ right: { outcome: 'accepted' } });

    const current = await readDocument();
    expect(current.emailTest.last).toMatchObject({
      actorUserId: OTHER_ID,
      outcome: 'accepted',
      requestId: 'late-request-b',
    });
    expect(calls).toHaveLength(2);
  });

  test('a notifications-off installation can still run an explicit test', async () => {
    await fixture.enableProvider({
      credential: 're_test_key',
      enabled: false,
      provider: 'resend',
    });
    const { calls, provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-disabled-ok',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const outcome = await runEither(
      runtime,
      sendTestEmailCommand(testInput('notifications-off')),
    );
    expect(Either.isRight(outcome)).toBe(true);
    expect((await readDocument()).email.enabled).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('a settings save during an in-flight test preserves both changes', async () => {
    await configuredResend();
    const gate = Effect.runSync(Deferred.make<boolean>());
    const { provider } = recordingProvider(() =>
      Deferred.await(gate).pipe(
        Effect.as({
          kind: 'accepted' as const,
          messageId: 're-inflight',
          provider: 'resend' as const,
        }),
      ),
    );
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );

    const sending = runEffect(
      runtime,
      sendTestEmailCommand(testInput('interleaved-test')),
    );

    // Wait until the reservation is committed before changing settings.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reservedDocument = await readDocument();
      if (reservedDocument.emailTest.last?.requestId === 'interleaved-test') {
        expect(reservedDocument.emailTest.last.outcome).toBe('sending');
        break;
      }

      if (Date.now() > deadline) {
        throw new Error('The test reservation was never written.');
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    fixture.setEmailBinding({
      send: async () => ({ messageId: 'cf-stub' }),
    });
    const saved = await runEither(
      runtime,
      updateEmailSettingsCommand(
        saveInput(1, {
          fromName: 'After Send',
          provider: 'cloudflare',
        }),
      ),
    );
    expect(Either.isRight(saved)).toBe(true);

    Effect.runSync(Deferred.succeed(gate, true));
    const outcome = await sending;
    expect(outcome.outcome).toBe('accepted');

    const document = await readDocument();
    // The settings save stands, and the completion only touched test state.
    expect(document.revision).toBe(2);
    expect(document.email.provider).toBe('cloudflare');
    expect(document.email.fromName).toBe('After Send');
    expect(document.emailTest.last).toMatchObject({
      configRevision: 1,
      outcome: 'accepted',
      requestId: 'interleaved-test',
    });
  });

  test('test reservations do not change the user-visible revision', async () => {
    await configuredResend();
    const { provider } = recordingProvider({
      kind: 'accepted',
      messageId: 're-version',
      provider: 'resend',
    });
    const runtime = makeNotificationRuntime(
      fixture.env,
      recordingResolver(provider),
    );
    const before = await fixture.readConfigRow();
    await runEffect(runtime, sendTestEmailCommand(testInput('test-version')));
    const after = await fixture.readConfigRow();
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    const document = decodeInstallationConfig(JSON.parse(after.documentJson));
    expect(document?.revision).toBe(1);
  });
});

describe('generic audit helpers', () => {
  test('raw appends are bounded and readable back', async () => {
    await appendAuditLog(fixture.env, {
      actorUserId: ADMIN_ID,
      now: new Date(),
      records: [
        {
          action: 'crm.lead_updated',
          changes: [{ after: 'Acme', before: null, field: 'lastName' }],
          resourceId: 'lead-1',
          resourceType: 'lead',
        },
      ],
    });
    const rows = await fixture.readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'crm.lead_updated',
      actorUserId: ADMIN_ID,
      resourceId: 'lead-1',
      resourceType: 'lead',
    });
  });
});
