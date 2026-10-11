import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import {
  MAINTENANCE_BATCH_LIMIT,
  NOTIFICATION_EVENT_TTL_MS,
  processNextNotification,
  runNotificationDispatch,
} from '@/application/notification-commands';
import {
  claimNextNotification,
  cleanupResolvedNotificationRows,
  completeNotificationAttempt,
  expireStaleNotificationIntents,
  freezeNotificationAttempt,
  getEmailSettings,
  getNotificationDispatchState,
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
      MAINTENANCE_BATCH_LIMIT,
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
      MAINTENANCE_BATCH_LIMIT,
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

    await recoverExpiredNotificationLeases(
      fixture.env,
      new Date(),
      MAINTENANCE_BATCH_LIMIT,
    );
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

    await recoverExpiredNotificationLeases(
      fixture.env,
      new Date(),
      MAINTENANCE_BATCH_LIMIT,
    );
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

describe('retry deadline and race fences', () => {
  const prepareResendRetry = async (input: {
    attemptAt: number;
    deadline: number;
    id: string;
    nextAttemptAt: number;
  }) => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_retry_key');
    await enabledUserAndLead();
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: input.attemptAt,
      delivery_key: deliveryKeyFor(input.id),
      first_attempt_at: input.attemptAt,
      frozen_envelope_json: serializeEnvelope(frozenEnvelope()),
      id: input.id,
      idempotency_deadline: input.deadline,
      leadId: LEAD_ID,
      next_attempt_at: input.nextAttemptAt,
      payload_hash: 'hash',
      provider: 'resend',
      reason_code: 'ambiguous',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
      uncertain_at: input.attemptAt,
    });
  };

  test('stops Resend retries at the exact deadline boundary', async () => {
    const t0 = Date.now();
    const deadline = t0 + HOUR;
    await prepareResendRetry({
      attemptAt: t0,
      deadline,
      id: 'deadline-boundary',
      nextAttemptAt: t0,
    });
    const { calls, sender } = recordingSender(
      { kind: 'accepted', messageId: 're-late', provider: 'resend' },
      'resend',
    );

    const outcome = await processNextNotification(fixture.env, {
      now: () => new Date(deadline),
      sender,
    });
    expect(outcome).toMatchObject({
      kind: 'unknown',
      reasonCode: 'idempotency_deadline_passed',
    });
    expect(calls).toHaveLength(0);
    const row = await readStrings('deadline-boundary');
    expect(row.status).toBe('unknown');
    expect(row.reason_code).toBe('idempotency_deadline_passed');
    expect(row.uncertain_at).not.toBeNull();
  });

  test('stops a retry when the deadline elapses during sender preparation', async () => {
    const t0 = Date.now();
    await prepareResendRetry({
      attemptAt: t0,
      deadline: t0 + HOUR,
      id: 'deadline-preparing',
      nextAttemptAt: t0,
    });
    const { calls, sender } = recordingSender(
      { kind: 'accepted', messageId: 're-late', provider: 'resend' },
      'resend',
    );

    let callCount = 0;
    const outcome = await processNextNotification(fixture.env, {
      now: () => {
        callCount += 1;
        return new Date(callCount === 1 ? t0 : t0 + 2 * HOUR);
      },
      sender,
    });
    expect(outcome).toMatchObject({
      kind: 'unknown',
      reasonCode: 'idempotency_deadline_passed',
    });
    expect(calls).toHaveLength(0);
    expect((await readStrings('deadline-preparing')).reason_code).toBe(
      'idempotency_deadline_passed',
    );
  });

  const rowDeadline = (now: Date) => new Date(now.getTime() + HOUR);

  const freezeWith = async (
    id: string,
    overrides: Record<string, unknown> = {},
    leaseExpiresAt?: number,
  ) => {
    const now = new Date();
    // Claim the exact row deterministically rather than whichever due row is
    // oldest when several scenarios share a fixture.
    await fixture.db
      .prepare(
        "UPDATE notification_outbox SET status = 'claimed', lease_token = 'freeze-token', lease_expires_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(leaseExpiresAt ?? now.getTime() + 60_000, now.getTime(), id)
      .run();
    return freezeNotificationAttempt(fixture.env, {
      configRevision: 1,
      deliveryKey: deliveryKeyFor(id),
      envelopeJson: serializeEnvelope(frozenEnvelope()),
      idempotencyDeadline: rowDeadline(now),
      leadId: LEAD_ID,
      leaseMs: 60_000,
      leaseToken: 'freeze-token',
      outboxId: id,
      payloadHash: 'hash',
      provider: 'cloudflare',
      recipientUserId: USER_ID,
      timestamp: now,
      writeToken: 'seed-1',
      ...overrides,
    });
  };

  const setupFreezeRow = async (id: string) => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();
    await fixture.insertOutbox({
      id,
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - 1,
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
    });
  };

  test('the freeze rejects a settings write that landed after the snapshot', async () => {
    await setupFreezeRow('freeze-settings');
    await fixture.db
      .prepare(
        "UPDATE email_settings SET write_token = 'rotated', revision = revision + 1",
      )
      .run();
    await expect(freezeWith('freeze-settings')).resolves.toBe(false);
  });

  test('the freeze rejects an opt-out, disabled user, or archived lead', async () => {
    await setupFreezeRow('freeze-optout');
    await fixture.optIn(USER_ID, false);
    await expect(freezeWith('freeze-optout')).resolves.toBe(false);
    await fixture.optIn(USER_ID, true);

    await setupFreezeRow('freeze-disabled');
    await fixture.db
      .prepare('UPDATE user SET disabled_at = ? WHERE id = ?')
      .bind(Date.now(), USER_ID)
      .run();
    await expect(freezeWith('freeze-disabled')).resolves.toBe(false);
    await fixture.db
      .prepare('UPDATE user SET disabled_at = NULL WHERE id = ?')
      .bind(USER_ID)
      .run();

    await setupFreezeRow('freeze-archived');
    await fixture.db
      .prepare('UPDATE leads SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), LEAD_ID)
      .run();
    await expect(freezeWith('freeze-archived')).resolves.toBe(false);
  });

  test('the freeze rejects an expired lease', async () => {
    await setupFreezeRow('freeze-lease');
    const now = new Date();
    await claimNextNotification(fixture.env, now, 'freeze-token', 60_000);
    await expect(
      freezeWith('freeze-lease', {}, now.getTime() - 1),
    ).resolves.toBe(false);
  });

  test('a settings change between snapshot and freeze stops the send as config_changed', async () => {
    await setupFreezeRow('race-settings');
    // An attempted (retry) row pinned to revision 1, then the settings change
    // lands between the snapshot and the freeze.
    await fixture.db
      .prepare(
        'UPDATE notification_outbox SET attempt_count = 1, config_revision = 1, status = ?, updated_at = ? WHERE id = ?',
      )
      .bind('retry', Date.now(), 'race-settings')
      .run();
    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    const outcome = await processNextNotification(fixture.env, {
      beforeFreeze: async () => {
        await fixture.db
          .prepare(
            "UPDATE email_settings SET write_token = 'rotated', revision = revision + 1",
          )
          .run();
      },
      sender,
    });
    expect(outcome).toMatchObject({
      kind: 'unknown',
      reasonCode: 'config_changed',
    });
    expect(calls).toHaveLength(0);
  });

  test('a pause recorded between snapshot and freeze stops the send', async () => {
    await setupFreezeRow('race-pause');
    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    const outcome = await processNextNotification(fixture.env, {
      beforeFreeze: async () => {
        await fixture.db
          .prepare(
            'UPDATE email_settings SET paused_revision = revision, paused_reason_code = ?, paused_at = ?',
          )
          .bind('E_SENDER_NOT_VERIFIED', Date.now())
          .run();
      },
      sender,
    });
    expect(outcome).toMatchObject({ kind: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  test('a disable or opt-out before freeze stops the send without contacting the provider', async () => {
    await setupFreezeRow('race-disable');
    const disabled = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, {
        beforeFreeze: async () => {
          await fixture.db
            .prepare(
              "UPDATE email_settings SET enabled = 0, write_token = 'rotated', revision = revision + 1",
            )
            .run();
        },
        sender: disabled.sender,
      }),
    ).resolves.toMatchObject({ kind: 'skipped', reasonCode: 'disabled' });
    expect(disabled.calls).toHaveLength(0);

    await setupFreezeRow('race-optout');
    const optedOut = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, {
        beforeFreeze: async () => {
          await fixture.optIn(USER_ID, false);
        },
        sender: optedOut.sender,
      }),
    ).resolves.toMatchObject({ kind: 'skipped', reasonCode: 'unsubscribed' });
    expect(optedOut.calls).toHaveLength(0);
  });

  test('a lost or expired lease before the external call never sends', async () => {
    await setupFreezeRow('race-lost-lease');
    const lost = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, {
        beforeFreeze: async () => {
          await fixture.db
            .prepare(
              "UPDATE notification_outbox SET lease_token = 'successor' WHERE id = ?",
            )
            .bind('race-lost-lease')
            .run();
        },
        sender: lost.sender,
      }),
    ).resolves.toMatchObject({ kind: 'idle' });
    expect(lost.calls).toHaveLength(0);

    await setupFreezeRow('race-expired-lease');
    const expired = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'cloudflare',
    });
    await expect(
      processNextNotification(fixture.env, {
        beforeFreeze: async () => {
          await fixture.db
            .prepare(
              'UPDATE notification_outbox SET lease_expires_at = ? WHERE id = ?',
            )
            .bind(Date.now() - 1, 'race-expired-lease')
            .run();
        },
        sender: expired.sender,
      }),
    ).resolves.toMatchObject({ kind: 'idle' });
    expect(expired.calls).toHaveLength(0);
    expect((await readStrings('race-expired-lease')).status).toBe('claimed');
  });

  test('an acknowledgement failure is reported as unknown and never as dispatch success', async () => {
    await setupFreezeRow('ack-failure');
    const { calls, sender } = recordingSender({
      kind: 'accepted',
      messageId: 'accepted-but-unrecorded',
      provider: 'cloudflare',
    });
    const outcome = await processNextNotification(fixture.env, {
      complete: async () => false,
      sender,
    });
    expect(outcome).toMatchObject({
      kind: 'unknown',
      reasonCode: 'ack_failed',
    });
    expect(calls).toHaveLength(1);
    // The durable row was not acknowledged, so recovery owns it and dispatch
    // success was not recorded.
    expect((await readStrings('ack-failure')).status).toBe('sending');
    expect(await getNotificationDispatchState(fixture.env)).toBeNull();
  });
});

describe('unresolved acceptance remains honest', () => {
  const ambiguousRow = async (
    id: string,
    overrides: Record<string, unknown> = {},
  ) => {
    await fixture.enableProvider({ provider: 'resend' });
    await fixture.insertCredential('re_ambig_key');
    await enabledUserAndLead();
    await fixture.insertOutbox({
      attempt_count: 1,
      config_revision: 1,
      created_at: Date.now() - HOUR,
      delivery_key: deliveryKeyFor(id),
      first_attempt_at: Date.now() - HOUR,
      frozen_envelope_json: serializeEnvelope(frozenEnvelope()),
      id,
      idempotency_deadline: Date.now() + HOUR,
      leadId: LEAD_ID,
      next_attempt_at: Date.now() - 1,
      provider: 'resend',
      reason_code: 'ambiguous',
      recipient_email: 'staff@example.test',
      recipient_user_id: USER_ID,
      status: 'retry',
      uncertain_at: Date.now() - HOUR,
      ...overrides,
    });
  };

  test('expiry preserves uncertainty after an abandoned retry claim returns to pending', async () => {
    const now = new Date();
    await ambiguousRow('ambig-pending-expiry', {
      created_at: now.getTime() - NOTIFICATION_EVENT_TTL_MS - 1,
      status: 'pending',
    });
    await expireStaleNotificationIntents(
      fixture.env,
      new Date(now.getTime() - NOTIFICATION_EVENT_TTL_MS),
      now,
      100,
    );
    expect((await readStrings('ambig-pending-expiry')).status).toBe('unknown');
  });

  test('an installation disable during an uncertain retry preserves unknown outcome', async () => {
    await ambiguousRow('ambig-install-disabled');
    const { calls, sender } = recordingSender(
      { kind: 'accepted', provider: 'resend' },
      'resend',
    );
    const outcome = await processNextNotification(fixture.env, {
      beforeFreeze: async () => {
        await fixture.db.prepare('UPDATE email_settings SET enabled = 0').run();
      },
      sender,
    });
    expect(outcome.kind).toBe('unknown');
    expect(calls).toHaveLength(0);
    expect((await readStrings('ambig-install-disabled')).status).toBe(
      'unknown',
    );
  });

  test('ambiguous retry delay is persisted so another tick cannot immediately resend', async () => {
    await ambiguousRow('ambig-delay');
    const now = new Date();
    const { calls, sender } = recordingSender(
      { kind: 'ambiguous', provider: 'resend', reason: 'transport_error' },
      'resend',
    );
    await expect(
      processNextNotification(fixture.env, { now: () => now, sender }),
    ).resolves.toMatchObject({ kind: 'retry' });
    const row = await fixture.readOutbox('ambig-delay');
    expect(row?.next_attempt_at).toBe(now.getTime() + 60_000);
    await expect(
      processNextNotification(fixture.env, {
        now: () => new Date(now.getTime() + 1),
        sender,
      }),
    ).resolves.toMatchObject({ kind: 'idle' });
    expect(calls).toHaveLength(1);
  });

  test('suppression after an ambiguous attempt becomes unknown, not skipped', async () => {
    await ambiguousRow('ambig-optout');
    await fixture.optIn(USER_ID, false);
    const { sender } = recordingSender({
      kind: 'accepted',
      messageId: 'must-not-send',
      provider: 'resend',
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'ambiguous_unsubscribed',
    });
    expect((await readStrings('ambig-optout')).status).toBe('unknown');

    await ambiguousRow('ambig-disabled');
    await fixture.db
      .prepare('UPDATE user SET disabled_at = ? WHERE id = ?')
      .bind(Date.now(), USER_ID)
      .run();
    await expect(processNextNotification(fixture.env)).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'ambiguous_account_disabled',
    });

    await ambiguousRow('ambig-archived');
    await fixture.db
      .prepare('UPDATE leads SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), LEAD_ID)
      .run();
    await expect(processNextNotification(fixture.env)).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'ambiguous_lead_closed',
    });
  });

  test('a definite rejection after ambiguity stays unknown and is never cleaned as resolved', async () => {
    await ambiguousRow('ambig-rejected');
    const { sender } = recordingSender({
      kind: 'rejected',
      provider: 'resend',
      reason: 'missing_api_key',
      retryable: false,
    });
    await expect(
      processNextNotification(fixture.env, { sender }),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'unresolved_after_rejection',
    });
    const row = await readStrings('ambig-rejected');
    expect(row.status).toBe('unknown');
    expect(row.uncertain_at).not.toBeNull();

    const old = Date.now() - 40 * 24 * HOUR;
    await fixture.db
      .prepare('UPDATE notification_outbox SET updated_at = ? WHERE id = ?')
      .bind(old, 'ambig-rejected')
      .run();
    await cleanupResolvedNotificationRows(fixture.env, new Date(), 100);
    expect(await fixture.readOutbox('ambig-rejected')).toBeDefined();
  });

  test('a retry reason cannot erase earlier uncertainty before expiry', async () => {
    await ambiguousRow('ambig-retry', {
      idempotency_deadline: Date.now() + 2 * HOUR,
    });
    const retryable = recordingSender({
      kind: 'rejected',
      provider: 'resend',
      reason: 'rate_limit_exceeded',
      retryable: true,
    });
    await expect(
      processNextNotification(fixture.env, { sender: retryable.sender }),
    ).resolves.toMatchObject({ kind: 'retry' });
    const afterRetry = await readStrings('ambig-retry');
    expect(afterRetry.status).toBe('retry');
    expect(afterRetry.uncertain_at).not.toBeNull();

    const later = Date.now() + NOTIFICATION_EVENT_TTL_MS + HOUR;
    await fixture.db
      .prepare('UPDATE notification_outbox SET created_at = ? WHERE id = ?')
      .bind(later - NOTIFICATION_EVENT_TTL_MS - HOUR, 'ambig-retry')
      .run();
    await expect(
      processNextNotification(fixture.env, { now: () => new Date(later) }),
    ).resolves.toMatchObject({
      kind: 'unknown',
      reasonCode: 'expired_ambiguous',
    });
  });
});

describe('bounded maintenance and error scope', () => {
  test('lease recovery and stale expiry honour their batch limits', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    await enabledUserAndLead();
    const stale = Date.now() - HOUR;
    for (const id of ['batch-a', 'batch-b', 'batch-c']) {
      await fixture.insertOutbox({
        created_at: stale,
        id,
        leadId: LEAD_ID,
        lease_expires_at: stale,
        lease_token: 'dead',
        next_attempt_at: stale,
        recipient_email: 'staff@example.test',
        recipient_user_id: USER_ID,
        status: 'claimed',
      });
    }

    expect(
      await recoverExpiredNotificationLeases(fixture.env, new Date(), 2),
    ).toBe(2);
    expect(
      await recoverExpiredNotificationLeases(fixture.env, new Date(), 2),
    ).toBe(1);

    const cutoff = new Date(Date.now() - NOTIFICATION_EVENT_TTL_MS - HOUR);
    for (const id of ['expire-a', 'expire-b', 'expire-c']) {
      await fixture.insertOutbox({
        created_at: stale - NOTIFICATION_EVENT_TTL_MS,
        id,
        leadId: LEAD_ID,
        recipient_email: 'staff@example.test',
        recipient_user_id: USER_ID,
      });
    }

    expect(
      await expireStaleNotificationIntents(fixture.env, cutoff, new Date(), 2),
    ).toBe(2);
    expect(
      await expireStaleNotificationIntents(fixture.env, cutoff, new Date(), 2),
    ).toBe(1);
  });

  test('the cleanup scan has a dedicated status/updated index', async () => {
    const indexes = await fixture.db
      .prepare("PRAGMA index_list('notification_outbox')")
      .all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toContain(
      'notification_outbox_cleanup_idx',
    );
  });

  test('only evidenced configuration failures pause the installation', async () => {
    await fixture.enableProvider({ provider: 'cloudflare' });
    configureCloudflareBinding();
    await enabledUserAndLead();

    const runRejection = async (
      id: string,
      result: SendResult,
      expectedKind: string,
    ) => {
      await fixture.insertOutbox({
        id,
        leadId: LEAD_ID,
        recipient_email: 'staff@example.test',
        recipient_user_id: USER_ID,
      });
      const { sender } = recordingSender(result);
      const outcome = await processNextNotification(fixture.env, { sender });
      expect(outcome.kind).toBe(expectedKind);
    };

    await runRejection(
      'scope-config',
      {
        kind: 'rejected',
        provider: 'cloudflare',
        reason: 'E_SENDER_NOT_VERIFIED',
        retryable: false,
      },
      'failed',
    );
    expect(
      (await getEmailSettings(fixture.env))?.pausedRevision,
    ).not.toBeNull();

    // Clear the pause so the next cases start from a clean revision.
    await fixture.db
      .prepare(
        'UPDATE email_settings SET paused_revision = NULL, paused_reason_code = NULL, paused_at = NULL',
      )
      .run();

    await runRejection(
      'scope-validation',
      {
        kind: 'rejected',
        provider: 'cloudflare',
        reason: 'E_VALIDATION_ERROR',
        retryable: false,
      },
      'failed',
    );
    expect((await getEmailSettings(fixture.env))?.pausedRevision).toBeNull();

    await runRejection(
      'scope-recipient',
      {
        kind: 'rejected',
        provider: 'cloudflare',
        reason: 'E_RECIPIENT_SUPPRESSED',
        retryable: false,
      },
      'failed',
    );
    expect((await getEmailSettings(fixture.env))?.pausedRevision).toBeNull();

    await runRejection(
      'scope-unknown',
      {
        kind: 'rejected',
        provider: 'cloudflare',
        reason: 'something_odd',
        retryable: false,
      },
      'failed',
    );
    expect((await getEmailSettings(fixture.env))?.pausedRevision).toBeNull();

    await runRejection(
      'scope-resend-config',
      {
        kind: 'rejected',
        provider: 'resend',
        reason: 'validation_error',
        retryable: false,
      },
      'failed',
    );
    expect((await getEmailSettings(fixture.env))?.pausedRevision).toBeNull();
  });
});
