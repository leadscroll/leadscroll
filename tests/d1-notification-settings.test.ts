import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  getEmailSettingsView,
  getEmailSettingsViewCommand,
  loadEmailSettingsState,
  sendTestEmailCommand,
  updateEmailSettingsCommand,
} from '@/application/notification-commands';
import { appendAuditLog } from '@/db/repository';
import {
  decodeAuditChanges,
  decodeInstallationConfig,
  type InstallationConfig,
} from '@/domain/schemas';
import { type EmailSender, type SendResult } from '@/notifications/email';
import { type FetchLike } from '@/notifications/providers/resend';
import { Effect, Either } from 'effect';
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

const run = async <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.either(effect));

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

const acceptedFetch =
  (messageId = 're-1'): FetchLike =>
  async () =>
    Response.json({ id: messageId });

const readDocument = async (): Promise<InstallationConfig> =>
  fixture.readConfig();

describe('installation configuration persistence', () => {
  test('creates revision 1 with a redacted audit entry and reloads the view', async () => {
    const saved = await run(
      updateEmailSettingsCommand(
        fixture.env,
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
    const changes = decodeAuditChanges(rows[0].changesJson);
    expect(changes).toEqual(
      expect.arrayContaining([
        { after: 'resend', before: 'disabled', field: 'email.provider' },
        { after: 'stored', before: null, field: 'email.credential' },
      ]),
    );
    expect(rows[0].changesJson).not.toContain('re_first_key');
    expect(rows[0].changesJson).not.toContain('ciphertext');

    const view = await getEmailSettingsView(fixture.env, SETTINGS_ORIGIN);
    expect(view.revision).toBe(1);
    expect(JSON.stringify(view)).not.toContain('re_first_key');
    expect(JSON.stringify(view)).not.toContain('ciphertext');
  });

  test('a stale revision conflicts and a lost CAS race leaves no audit entry', async () => {
    await fixture.enableProvider({ provider: 'cloudflare', revision: 2 });
    const stale = await run(
      updateEmailSettingsCommand(fixture.env, saveInput(1)),
    );
    expect(Either.isLeft(stale)).toBe(true);
    if (Either.isLeft(stale)) {
      expect(stale.left).toMatchObject({ code: 'revision_conflict' });
    }

    expect(await fixture.readAuditRows()).toHaveLength(0);

    // Two concurrent saves from the same revision: exactly one wins and the
    // loser's attempted audit is never written.
    const [first, second] = await Promise.all([
      run(updateEmailSettingsCommand(fixture.env, saveInput(2))),
      run(
        updateEmailSettingsCommand(
          fixture.env,
          saveInput(2, { actorUserId: OTHER_ID, fromName: 'Second' }),
        ),
      ),
    ]);
    const rights = [first, second].filter((outcome) => Either.isRight(outcome));
    const lefts = [first, second].filter((outcome) => Either.isLeft(outcome));
    expect(rights).toHaveLength(1);
    expect(lefts).toHaveLength(1);
    expect(await fixture.readAuditRows()).toHaveLength(1);
    expect((await readDocument()).revision).toBe(3);
  });

  test('stores the credential encrypted and records remove/replace markers', async () => {
    await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(0, {
          credential: { operation: 'replace', value: 're_secret_key' },
        }),
      ),
    );
    const stored = await readDocument();
    expect(stored.email.credential?.ciphertext).not.toContain('re_secret_key');

    await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(1, {
          credential: { operation: 'replace', value: 're_replaced_key' },
        }),
      ),
    );
    await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(2, {
          credential: { operation: 'remove' },
          provider: 'resend',
        }),
      ),
    );

    const rows = await fixture.readAuditRows();
    const markers = rows.flatMap(
      (row) =>
        decodeAuditChanges(row.changesJson)
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
    const missing = await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(0, { credential: { operation: 'replace', value: 're_key' } }),
      ),
    );
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) {
      expect(missing.left).toMatchObject({ code: 'encryption_key_missing' });
    }

    fixture.setEncryptionKey('not-a-valid-key');
    const invalid = await run(
      updateEmailSettingsCommand(
        fixture.env,
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

    const view = await run(
      getEmailSettingsViewCommand(fixture.env, SETTINGS_ORIGIN),
    );
    expect(Either.isLeft(view)).toBe(true);
    if (Either.isLeft(view)) {
      expect(view.left).toMatchObject({ code: 'config_unavailable' });
    }

    const saved = await run(
      updateEmailSettingsCommand(fixture.env, saveInput(0)),
    );
    expect(Either.isLeft(saved)).toBe(true);
    if (Either.isLeft(saved)) {
      expect(saved.left).toMatchObject({ code: 'config_unavailable' });
    }

    expect((await fixture.readConfigRow()).documentJson).toBe(
      rawBefore.documentJson,
    );
    expect(await fixture.readAuditRows()).toHaveLength(0);

    // Self-service and subscriber state degrade to a redacted misconfigured
    // state instead of throwing.
    const state = await loadEmailSettingsState(fixture.env);
    expect(state).toMatchObject({
      availability: 'misconfigured',
      readinessReason: 'config_invalid',
      settings: null,
    });
  });

  test('exposes readiness and redacted credential presence', async () => {
    await fixture.enableProvider({ provider: 'resend' });
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

  test('a disabled installation switch is reported as disabled', async () => {
    await fixture.enableProvider({ enabled: false, provider: 'cloudflare' });
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'stub' }),
    });

    const state = await loadEmailSettingsState(fixture.env);
    expect(state.availability).toBe('disabled');
    const view = await getEmailSettingsView(fixture.env, SETTINGS_ORIGIN);
    expect(view.enabled).toBe(false);
  });

  test('audit changes do not appear for a settings no-op', async () => {
    await fixture.enableProvider({ provider: 'cloudflare', revision: 1 });
    const outcome = await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(1, { provider: 'cloudflare' }),
      ),
    );
    expect(Either.isRight(outcome)).toBe(true);
    const rows = await fixture.readAuditRows();
    expect(rows).toHaveLength(1);
    expect(decodeAuditChanges(rows[0].changesJson)).toEqual([]);
  });
});

describe('administrator test email command', () => {
  test('sends once, keeps the settings revision, and audits the outcome', async () => {
    await configuredResend();
    const calls: Array<{ key: string; to: string }> = [];
    const fetchMock: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string[] };
      calls.push({
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

    const document = await readDocument();
    expect(document.revision).toBe(1);
    expect(document.emailTest.last).toMatchObject({
      actorUserId: ADMIN_ID,
      configRevision: 1,
      outcome: 'accepted',
      requestId: 'test-req-1',
    });
    expect(calls).toEqual([
      {
        key: 'leadscroll-email-test:test-req-1',
        to: 'admin@example.test',
      },
    ]);

    const rows = await fixture.readAuditRows();
    const testRows = rows.filter((row) => row.action === 'email.test_sent');
    expect(testRows).toHaveLength(1);
    expect(testRows[0].actorUserId).toBe(ADMIN_ID);

    // The same request id is an idempotent response, not a second send.
    const replay = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-1'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isRight(replay)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('an ambiguous outcome is honest and is never automatically retried', async () => {
    await configuredResend();
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error('timeout');
    });
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
    const fetchMock = vi.fn<FetchLike>(acceptedFetch('re-concurrent'));
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const document = await readDocument();
    expect(document.emailTest.recent).toHaveLength(1);
    expect(document.emailTest.last?.outcome).toBe('accepted');
  });

  test('enforces one per minute and five per rolling 24 hours', async () => {
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

    // The rolling window prunes after 24 hours and the bounded array stays at
    // the small window size instead of growing without limit.
    const nextDay = await run(
      sendTestEmailCommand(fixture.env, testInput('test-next-day'), {
        fetchImplementation: fetchMock,
        now: () => new Date(start + 5 * 61_000 + 24 * 60 * 60 * 1_000),
      }),
    );
    expect(Either.isRight(nextDay)).toBe(true);
    const document = await readDocument();
    expect(document.emailTest.recent).toHaveLength(1);
  });

  test('a decryption failure records a configuration error without sending', async () => {
    await configuredResend();
    await fixture.db
      .prepare(
        "UPDATE installation_config SET document_json = json_set(document_json, '$.email.credential.ciphertext', 'not-a-valid-envelope') WHERE workspace_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'",
      )
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
    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('test-req-stale', 99)),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'revision_conflict' });
    }

    expect((await readDocument()).emailTest.last).toBeNull();
  });

  test("another actor's request id is a conflict that never sends or leaks", async () => {
    await configuredResend();
    const first = await run(
      sendTestEmailCommand(
        fixture.env,
        {
          ...testInput('foreign-request'),
          actorEmail: 'other@example.test',
          actorUserId: OTHER_ID,
        },
        { fetchImplementation: acceptedFetch('re-other') },
      ),
    );
    expect(Either.isRight(first)).toBe(true);

    const fetchMock = vi.fn<FetchLike>(acceptedFetch('re-must-not-send'));
    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('foreign-request'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ code: 'test_request_conflict' });
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('two actors racing the same request id never receive the other actor data', async () => {
    await configuredResend();
    const fetchMock = vi.fn<FetchLike>(acceptedFetch('re-race'));
    const base = Date.now();

    for (let index = 0; index < 5; index += 1) {
      const requestId = `race-request-${index}`;
      const at = base + index * 61_000;
      const [first, second] = await Promise.all([
        run(
          sendTestEmailCommand(fixture.env, testInput(requestId), {
            fetchImplementation: fetchMock,
            now: () => new Date(at),
          }),
        ),
        run(
          sendTestEmailCommand(
            fixture.env,
            {
              ...testInput(requestId),
              actorEmail: 'other@example.test',
              actorUserId: OTHER_ID,
            },
            { fetchImplementation: fetchMock, now: () => new Date(at) },
          ),
        ),
      ]);

      const accepted: number[] = [];
      const conflicts: string[] = [];
      for (const outcome of [first, second]) {
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
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('a notifications-off installation can still run an explicit test', async () => {
    await fixture.enableProvider({
      credential: 're_test_key',
      enabled: false,
      provider: 'resend',
    });
    const fetchMock = vi.fn<FetchLike>(acceptedFetch('re-disabled-ok'));
    const outcome = await run(
      sendTestEmailCommand(fixture.env, testInput('notifications-off'), {
        fetchImplementation: fetchMock,
      }),
    );
    expect(Either.isRight(outcome)).toBe(true);
    expect((await readDocument()).email.enabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a settings save during an in-flight test preserves both changes', async () => {
    await configuredResend();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender: EmailSender = {
      provider: 'resend',
      send: async (): Promise<SendResult> => {
        await gate;
        return { kind: 'accepted', provider: 'resend' };
      },
    };

    const sending = Effect.runPromise(
      sendTestEmailCommand(fixture.env, testInput('interleaved-test'), {
        sender,
      }),
    );

    // Wait until the reservation is committed before changing settings.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reserved = await readDocument();
      if (reserved.emailTest.last?.requestId === 'interleaved-test') {
        expect(reserved.emailTest.last.outcome).toBe('sending');
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
    const saved = await run(
      updateEmailSettingsCommand(
        fixture.env,
        saveInput(1, {
          fromName: 'After Send',
          provider: 'cloudflare',
        }),
      ),
    );
    expect(Either.isRight(saved)).toBe(true);

    release();
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
    const before = await fixture.readConfigRow();
    await run(
      sendTestEmailCommand(fixture.env, testInput('test-version'), {
        fetchImplementation: acceptedFetch(),
      }),
    );
    const after = await fixture.readConfigRow();
    expect(after.writeVersion).toBeGreaterThan(before.writeVersion);
    const document = decodeInstallationConfig(after.documentJson);
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
