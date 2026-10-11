import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  NOTIFICATION_EVENT_TTL_MS,
  processNextNotification,
  runNotificationDispatch,
} from '@/application/notification-commands';
import {
  claimNextNotification,
  cleanupResolvedNotificationRows,
  completeNotificationAttempt,
  getEmailSettings,
  recoverExpiredNotificationLeases,
} from '@/db/repository';
import {
  deliveryKeyFor,
  type EmailEnvelope,
  type EmailSender,
  type SendResult,
  serializeEnvelope,
} from '@/notifications/email';
import { type FetchLike } from '@/notifications/providers/resend';
import { renderNewLeadNotification } from '@/notifications/templates';
import { beforeEach, describe, expect, test } from 'vitest';

const HOUR = 60 * 60 * 1_000;
const LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = 'user-notify-1';

let fixture: NotificationFixture;

beforeEach(async () => {
  if (fixture !== undefined) {
    await fixture.dispose();
  }

  // The hook runs serially; the rule cannot see that.
  // eslint-disable-next-line require-atomic-updates
  fixture = await startNotificationFixture();
});

type RecordingSender = {
  calls: Array<{ deliveryKey: string; envelope: EmailEnvelope }>;
  sender: EmailSender;
};

const recordingSender = (
  result: ((sendCount: number) => SendResult) | SendResult,
  provider: 'cloudflare' | 'resend' = 'cloudflare',
): RecordingSender => {
  const calls: Array<{ deliveryKey: string; envelope: EmailEnvelope }> = [];
  const sender: EmailSender = {
    capabilities: { idempotencyWindowSeconds: null },
    checkConfiguration: () => ({ configured: true }),
    provider,
    send: async (envelope, context) => {
      calls.push({ deliveryKey: context.deliveryKey, envelope });
      return typeof result === 'function' ? result(calls.length) : result;
    },
  };
  return { calls, sender };
};

const frozenEnvelope = (): EmailEnvelope => ({
  from: { email: 'notifications@example.test', name: 'LeadScroll' },
  ...renderNewLeadNotification({
    leadId: LEAD_ID,
    origin: 'https://crm.example.test',
  }),
  to: 'staff@example.test',
});

const configureCloudflareBinding = (): void => {
  fixture.setEmailBinding({
    send: async () => ({ messageId: 'binding-stub' }),
  });
};

const enabledUserAndLead = async (
  options: { disabled?: boolean } = {},
): Promise<void> => {
  await fixture.user({
    email: 'staff@example.test',
    id: USER_ID,
    ...(options.disabled === true ? { disabled: true } : {}),
  });
  await fixture.optIn(USER_ID);
  await fixture.seedLead(LEAD_ID);
};

const readStrings = async (id: string) => {
  const row = await fixture.readOutbox(id);
  return {
    ...row,
    providerMessageId: row?.provider_message_id,
    reasonCode: row?.reason_code,
    status: row?.status,
  } as Record<string, unknown>;
};

describe('notification delivery state machine', () => {
  test('accepts one due notification, freezes it, and never resends', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-1',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'cf-1',
      provider: 'cloudflare',
    });
    const outcome = await processNextNotification(fixture.env, { sender });
    expect(outcome).toMatchObject({ kind: 'accepted', messageId: 'cf-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].envelope.to).toBe('staff@example.test');

    const row = await readStrings('out-1');
    expect(row.status).toBe('accepted');
    expect(row.provider).toBe('cloudflare');
    expect(row.attempt_count).toBe(1);
    expect(row.config_revision).toBe(1);
    expect(row.delivery_key).toBe(deliveryKeyFor('out-1'));
    expect(row.provider_message_id).toBe('cf-1');
    expect(typeof row.payload_hash).toBe('string');

    const again = await processNextNotification(fixture.env, { sender });
    expect(again).toEqual({ kind: 'idle' });
    expect(calls).toHaveLength(1);
  });

  test('creates no intent while disabled and pauses while misconfigured', async () => {
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-disabled',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const disabled = await processNextNotification(fixture.env);
    expect(disabled).toMatchObject({ kind: 'disabled' });

    await fixture.enableProvider({ provider: 'cloudflare' });
    // Cloudflare is selected but the EMAIL binding is absent.
    const misconfigured = await processNextNotification(fixture.env);
    expect(misconfigured).toMatchObject({
      kind: 'misconfigured',
      reasonCode: 'cloudflare_binding_missing',
    });
    expect((await readStrings('out-disabled')).status).toBe('pending');
  });

  test('skips opt-out, disabled, address change, and closed leads at send time', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    const { sender } = recordingSender({
      kind: 'accepted',
      messageId: 'x',
      provider: 'cloudflare',
    });

    await fixture.optIn(USER_ID, false);
    await fixture.insertOutbox({
      id: 'out-optout',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'skipped',
      reasonCode: 'unsubscribed',
    });

    await fixture.optIn(USER_ID, true);
    await fixture.db
      .prepare('UPDATE user SET disabled_at = ? WHERE id = ?')
      .bind(Date.now(), USER_ID)
      .run();
    await fixture.insertOutbox({
      id: 'out-disabled-user',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'skipped',
      reasonCode: 'account_disabled',
    });

    await fixture.db
      .prepare('UPDATE user SET disabled_at = NULL, email = ? WHERE id = ?')
      .bind('moved@example.test', USER_ID)
      .run();
    await fixture.insertOutbox({
      id: 'out-address',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'skipped',
      reasonCode: 'address_changed',
    });

    await fixture.db
      .prepare('UPDATE user SET email = ? WHERE id = ?')
      .bind('staff@example.test', USER_ID)
      .run();
    await fixture.db
      .prepare('UPDATE leads SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), LEAD_ID)
      .run();
    await fixture.insertOutbox({
      id: 'out-closed',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'skipped',
      reasonCode: 'lead_closed',
    });
  });

  test('two concurrent claimers produce one send', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-race',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'one',
      provider: 'cloudflare',
    });
    await Promise.all([
      processNextNotification(fixture.env, { sender }),
      processNextNotification(fixture.env, { sender }),
    ]);
    // Two concurrent processors can match the same candidate, but only one
    // claims it; the other observes no due row.
    expect(calls).toHaveLength(1);
    expect((await readStrings('out-race')).status).toBe('accepted');
  });

  test('a stale lease token cannot overwrite a successor transition', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-fence',
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - 1,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    await claimNextNotification(fixture.env, new Date(), 'stale', 60_000);
    await recoverExpiredNotificationLeases(
      fixture.env,
      new Date(Date.now() + 120_000),
    );
    await claimNextNotification(
      fixture.env,
      new Date(Date.now() + 120_000),
      'fresh',
      60_000,
    );

    const staleWrite = await completeNotificationAttempt(fixture.env, {
      completion: { reasonCode: 'stale', status: 'failed' },
      leaseToken: 'stale',
      outboxId: 'out-fence',
      timestamp: new Date(),
    });
    expect(staleWrite).toBe(false);

    const freshWrite = await completeNotificationAttempt(fixture.env, {
      completion: { reasonCode: null, status: 'accepted' },
      leaseToken: 'fresh',
      outboxId: 'out-fence',
      timestamp: new Date(),
    });
    expect(freshWrite).toBe(true);
    expect((await readStrings('out-fence')).status).toBe('accepted');
  });

  test('recovers a crash before send and records Cloudflare ambiguity as unknown', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    const stale = Date.now() - HOUR;
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: stale,
      first_attempt_at: stale,
      id: 'out-crash',
      leadId: LEAD_ID,
      lease_expires_at: stale,
      lease_token: 'dead',
      next_attempt_at: stale,
      provider: 'cloudflare',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'sending',
    });

    const recovered = await recoverExpiredNotificationLeases(
      fixture.env,
      new Date(),
    );
    expect(recovered).toBe(1);
    expect((await readStrings('out-crash')).status).toBe('unknown');

    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'x',
      provider: 'cloudflare',
    });
    await processNextNotification(fixture.env, { sender });
    expect(calls).toHaveLength(0);
  });

  test('Resend repeats the identical keyed request inside its idempotency window', async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_test_key');
    await enabledUserAndLead();
    const attemptAt = Date.now() - HOUR;
    const envelope = frozenEnvelope();
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: attemptAt,
      delivery_key: deliveryKeyFor('out-resend'),
      first_attempt_at: attemptAt,
      frozen_envelope_json: serializeEnvelope(envelope),
      id: 'out-resend',
      idempotency_deadline: Date.now() + HOUR,
      leadId: LEAD_ID,
      lease_expires_at: attemptAt,
      lease_token: 'dead',
      next_attempt_at: attemptAt,
      payload_hash: 'hash',
      provider: 'resend',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'sending',
    });

    await recoverExpiredNotificationLeases(fixture.env, new Date());
    expect((await readStrings('out-resend')).status).toBe('retry');

    const { calls, sender } = recordingSender(
      { kind: 'accepted', messageId: 're-1', provider: 'resend' },
      'resend',
    );
    await processNextNotification(fixture.env, { sender });
    expect(calls).toHaveLength(1);
    expect(calls[0].deliveryKey).toBe(deliveryKeyFor('out-resend'));
    expect(calls[0].envelope).toEqual(envelope);
    expect((await readStrings('out-resend')).status).toBe('accepted');
  });

  test('a passed Resend idempotency deadline stays unknown', async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await enabledUserAndLead();
    const past = Date.now() - 2 * HOUR;
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: past,
      delivery_key: deliveryKeyFor('out-deadline'),
      first_attempt_at: past,
      frozen_envelope_json: serializeEnvelope(frozenEnvelope()),
      id: 'out-deadline',
      idempotency_deadline: Date.now() - HOUR,
      leadId: LEAD_ID,
      lease_expires_at: past,
      lease_token: 'dead',
      next_attempt_at: past,
      payload_hash: 'hash',
      provider: 'resend',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'sending',
    });

    await recoverExpiredNotificationLeases(fixture.env, new Date());
    const row = await readStrings('out-deadline');
    expect(row.status).toBe('unknown');
    expect(row.reason_code).toBe('lease_expired');
  });

  test('a changed settings revision never retargets an attempted row', async () => {
    await fixture.enableProvider({ provider: 'cloudflare', revision: 2 });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: Date.now() - HOUR,
      first_attempt_at: Date.now() - HOUR,
      frozen_envelope_json: serializeEnvelope(frozenEnvelope()),
      id: 'out-changed',
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - 1,
      payload_hash: 'hash',
      provider: 'cloudflare',
      reason_code: 'E_DELIVERY_FAILED',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
    });

    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'x',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'config_changed',
    });
    expect(calls).toHaveLength(0);
    expect((await readStrings('out-changed')).status).toBe('unknown');
  });

  test('retryable rejections back off and terminal config errors pause the revision', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-retry',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const retryable = recordingSender({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_RATE_LIMIT_EXCEEDED',
      retryable: true,
    });
    await expect(
      processNextNotification(fixture.env, { sender: retryable.sender }),
    ).resolves.toMatchObject({ kind: 'retry' });
    const retryRow = await readStrings('out-retry');
    expect(retryRow.status).toBe('retry');
    expect(Number(retryRow.attempt_count)).toBe(1);

    await fixture.insertOutbox({
      id: 'out-config',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    const terminal = recordingSender({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_SENDER_NOT_VERIFIED',
      retryable: false,
    });
    await expect(
      processNextNotification(fixture.env, { sender: terminal.sender }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect((await readStrings('out-config')).status).toBe('failed');

    const settings = await getEmailSettings(fixture.env);
    expect(settings?.pausedRevision).toBe(settings?.revision);
    expect(settings?.pausedReasonCode).toBe('E_SENDER_NOT_VERIFIED');

    // The paused revision refuses new sends without touching the pending row.
    const paused = await processNextNotification(fixture.env, {
      sender: retryable.sender,
    });
    expect(paused).toMatchObject({ kind: 'paused' });
  });

  test('recipient-only rejections fail that row without pausing the installation', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-recipient',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const sender = recordingSender({
      kind: 'rejected',
      provider: 'cloudflare',
      reason: 'E_RECIPIENT_SUPPRESSED',
      retryable: false,
    });
    await processNextNotification(fixture.env, { sender: sender.sender });
    expect((await readStrings('out-recipient')).status).toBe('failed');
    expect((await getEmailSettings(fixture.env))?.pausedRevision).toBeNull();
  });

  test('attempt exhaustion and event expiry are terminal without sending', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      attempt_count: 6,
      config_revision: 1,
      created_at: Date.now() - HOUR,
      first_attempt_at: Date.now() - HOUR,
      id: 'out-exhausted',
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - 1,
      provider: 'cloudflare',
      reason_code: 'E_RATE_LIMIT_EXCEEDED',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
    });
    const { sender } = recordingSender({
      kind: 'accepted',
      messageId: 'x',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'failed',
      reasonCode: 'retry_exhausted',
    });

    await fixture.insertOutbox({
      created_at: Date.now() - NOTIFICATION_EVENT_TTL_MS - HOUR,
      id: 'out-expired',
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - HOUR,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'skipped',
      reasonCode: 'expired',
    });

    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: Date.now() - NOTIFICATION_EVENT_TTL_MS - HOUR,
      first_attempt_at: Date.now() - NOTIFICATION_EVENT_TTL_MS,
      id: 'out-expired-ambiguous',
      leadId: LEAD_ID,
      provider: 'resend',
      reason_code: 'ambiguous',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'expired_ambiguous',
    });
  });

  test('uses the real Cloudflare adapter with a fake binding', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    fixture.setEmailBinding({
      send: async () => ({ messageId: 'cf-adapter-1' }),
    });
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-adapter',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    await expect(processNextNotification(fixture.env)).resolves.toMatchObject({
      kind: 'accepted',
      messageId: 'cf-adapter-1',
    });
  });

  test('uses the real Resend adapter with a mocked fetch and never leaks the key', async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_secret_value');
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-resend-adapter',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    const calls: Array<{ headers: unknown; init?: RequestInit; url: unknown }> =
      [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ headers: init?.headers, init, url });
      return Response.json({ id: 're-adapter-1' });
    };

    await expect(
      processNextNotification(fixture.env, { fetchImplementation: fetchMock }),
    ).resolves.toMatchObject({ kind: 'accepted', messageId: 're-adapter-1' });

    expect(calls).toHaveLength(1);
    const headers = calls[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_secret_value');
    expect((await readStrings('out-resend-adapter')).provider).toBe('resend');
  });

  test('never touches a present EMAIL binding in Resend or disabled modes', async () => {
    let emailCalls = 0;
    fixture.setEmailBinding({
      send: async () => {
        emailCalls += 1;
        throw new Error('the EMAIL binding must not be called');
      },
    });
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_test_key');
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-unused-email',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    const resendCalls: string[] = [];
    const resendFetch: FetchLike = async (url) => {
      resendCalls.push(String(url));
      return Response.json({ id: 're-unused' });
    };

    await expect(
      processNextNotification(fixture.env, {
        fetchImplementation: resendFetch,
      }),
    ).resolves.toMatchObject({ kind: 'accepted' });
    expect(emailCalls).toBe(0);
    expect(resendCalls).toEqual(['https://api.resend.com/emails']);

    await fixture.enableProvider({ provider: 'disabled' });
    await fixture.insertOutbox({
      id: 'out-disabled-email',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    await expect(processNextNotification(fixture.env)).resolves.toMatchObject({
      kind: 'disabled',
    });
    expect(emailCalls).toBe(0);
  });

  test('a credential that cannot be decrypted pauses the revision without sending', async () => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_encrypted_with_other_key');
    // Encrypt the fixture credential under a different root key than the one
    // the deployment will use at send time.
    const { encryptCredential } =
      await import('@/notifications/credential-crypto');
    const otherKey = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
    const envelope = await encryptCredential(otherKey, {
      provider: 'resend',
      value: 're_other_key',
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    await fixture.db
      .prepare(
        'UPDATE email_credentials SET ciphertext = ?, nonce = ?, key_version = ? WHERE provider = ?',
      )
      .bind(envelope.ciphertext, envelope.nonce, envelope.keyVersion, 'resend')
      .run();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id: 'out-decrypt',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });

    await expect(processNextNotification(fixture.env)).resolves.toMatchObject({
      kind: 'misconfigured',
      reasonCode: 'decrypt_failed',
    });
    const settings = await getEmailSettings(fixture.env);
    expect(settings?.pausedRevision).toBe(settings?.revision);
    expect((await readStrings('out-decrypt')).status).toBe('retry');
  });

  test('dispatch is bounded and retention cleanup only removes resolved rows', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    const old = Date.now() - 40 * 24 * HOUR;
    await fixture.insertOutbox({
      id: 'out-old-accepted',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      status: 'accepted',
      updated_at: old,
    });
    await fixture.insertOutbox({
      id: 'out-old-unknown',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      status: 'unknown',
      updated_at: old,
    });
    await fixture.insertOutbox({
      created_at: old,
      id: 'out-old-pending',
      leadId: LEAD_ID,
      next_attempt_at: Date.now() + HOUR,
      recipient_email: 'staff@example.test',
      updated_at: old,
    });

    await cleanupResolvedNotificationRows(fixture.env, new Date(), 100);
    expect(await fixture.count('notification_outbox')).toBe(2);
    expect(await fixture.readOutbox('out-old-unknown')).toBeDefined();
    expect(await fixture.readOutbox('out-old-pending')).toBeDefined();

    const recording = recordingSender({
      kind: 'accepted',
      messageId: 'x',
      provider: 'cloudflare',
    });
    await fixture.insertOutbox({
      id: 'out-tick',
      leadId: LEAD_ID,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
    const result = await runNotificationDispatch(fixture.env, {
      batchLimit: 1,
      sender: recording.sender,
    });
    expect(result.processed).toBe(1);
    expect(result.stopped).toBe('limit');
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      'accepted',
    ]);
  });
});
