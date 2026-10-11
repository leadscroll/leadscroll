/**
 * Application commands for new-lead email notifications.
 *
 * Business rules live here per the repository boundary: recipient
 * availability, provider selection, credential decryption, the fenced
 * delivery state machine, administrator settings/test sends, and bounded
 * scheduled dispatch. Repository modules own D1 access; provider adapters own
 * provider-specific wire behavior.
 */

import { DomainError, PersistenceError } from '@/application/errors';
import {
  claimNextNotification,
  cleanupResolvedNotificationRows,
  clearEmailSettingsPause,
  completeNotificationAttempt,
  completeNotificationTestAttempt,
  type EmailCredentialRecord,
  type EmailSettingsRecord,
  type Env,
  expireStaleNotificationIntents,
  freezeNotificationAttempt,
  freezeNotificationTestAttempt,
  getEmailCredential,
  getEmailSettings,
  getLatestNotificationTestAttempt,
  getNotificationEligibility,
  getNotificationPreference,
  getNotificationTestAttempt,
  listNotificationHistory,
  type NotificationCompletion,
  type NotificationHistoryPage,
  type NotificationOutboxRecord,
  type NotificationTestAttemptRecord,
  recordEmailSettingsAudit,
  recordEmailSettingsConfigError,
  recordNotificationDispatchConfigError,
  recordNotificationDispatchSuccess,
  recordNotificationDispatchTick,
  recoverExpiredNotificationLeases,
  renewNotificationLease,
  reserveNotificationTestAttempt,
  saveEmailSettings,
  upsertNotificationPreference,
} from '@/db/repository';
import { type NotificationStatus } from '@/db/schema';
import { decodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from '@/notifications/credential-crypto';
import {
  deliveryKeyFor,
  type EmailEnvelope,
  type EmailProvider,
  type EmailSender,
  envelopePayloadHash,
  parseEnvelope,
  type SendResult,
  serializeEnvelope,
  testDeliveryKeyFor,
} from '@/notifications/email';
import { createCloudflareEmailSender } from '@/notifications/providers/cloudflare';
import {
  createResendEmailSender,
  type FetchLike,
} from '@/notifications/providers/resend';
import {
  renderNewLeadNotification,
  renderTestEmail,
} from '@/notifications/templates';
import { Effect } from 'effect';

// --- Constants ---------------------------------------------------------------

export const NOTIFICATION_EVENT_TTL_MS = 24 * 60 * 60 * 1_000;
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const NOTIFICATION_LEASE_MS = 5 * 60 * 1_000;
export const NOTIFICATION_MAX_ATTEMPTS = 6;
/**
 * Resend keeps idempotency keys for 24h; retry with a safety margin.
 */
export const RESEND_IDEMPOTENCY_SAFETY_MS = 5 * 60 * 1_000;
export const DISPATCH_BATCH_LIMIT = 1;
export const DISPATCH_TIME_BUDGET_MS = 20_000;

const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3_600, 21_600] as const;

const RECIPIENT_REJECTION_REASONS = new Set([
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
]);

const RETRYABLE_TEST_REASONS = new Set([
  'concurrent_idempotent_requests',
  'quota_or_rate_limited',
  'rate_limit_exceeded',
]);

// --- Effect helpers ----------------------------------------------------------

const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });

const domainError = (code: string, message: string, details?: unknown) =>
  new DomainError({ code, details, message });

// --- Settings availability ---------------------------------------------------

export type EmailSettingsState = {
  availability: NotificationAvailability;
  credential: EmailCredentialRecord | null;
  hasCloudflareBinding: boolean;
  hasEncryptionKey: boolean;
  hasResendCredential: boolean;
  paused: boolean;
  provider: EmailProvider | null;
  readinessReason: null | string;
  settings: EmailSettingsRecord | null;
};

export type NotificationAvailability =
  'configured' | 'disabled' | 'misconfigured' | 'unavailable';

const hasConfiguredEncryptionKey = (environment: Env): boolean =>
  (environment.EMAIL_SETTINGS_ENCRYPTION_KEY?.trim() ?? '') !== '';

const configuredReadiness = (
  state: {
    credential: EmailCredentialRecord | null;
    hasCloudflareBinding: boolean;
    hasEncryptionKey: boolean;
  },
  settings: EmailSettingsRecord,
): null | string => {
  if (settings.fromEmail === null || settings.fromEmail.length === 0) {
    return 'from_email_missing';
  }

  if (settings.provider === 'cloudflare') {
    return state.hasCloudflareBinding ? null : 'cloudflare_binding_missing';
  }

  if (state.credential === null) {
    return 'resend_api_key_missing';
  }

  return state.hasEncryptionKey ? null : 'encryption_key_missing';
};

/**
 * Local, no-network readiness. `configured` means the saved selection has the
 * resources it needs as far as this deployment can tell; it is never evidence
 * of remote entitlement or an accepted test message.
 */
export const loadEmailSettingsState = async (
  environment: Env,
): Promise<EmailSettingsState> => {
  const settings = await getEmailSettings(environment);
  const hasCloudflareBinding = environment.EMAIL !== undefined;
  const hasEncryptionKey = hasConfiguredEncryptionKey(environment);

  if (settings === null || settings.provider === 'disabled') {
    return {
      availability: 'disabled',
      credential: null,
      hasCloudflareBinding,
      hasEncryptionKey,
      hasResendCredential: false,
      paused: false,
      provider: null,
      readinessReason: null,
      settings,
    };
  }

  const credential =
    settings.provider === 'resend'
      ? await getEmailCredential(environment, 'resend')
      : null;
  const paused =
    settings.pausedRevision !== null &&
    settings.pausedRevision === settings.revision;
  const readinessReason = configuredReadiness(
    { credential, hasCloudflareBinding, hasEncryptionKey },
    settings,
  );

  let availability: NotificationAvailability;
  if (paused) {
    availability = 'unavailable';
  } else if (!settings.enabled) {
    availability = 'disabled';
  } else if (readinessReason === null) {
    availability = 'configured';
  } else {
    availability = 'misconfigured';
  }

  return {
    availability,
    credential,
    hasCloudflareBinding,
    hasEncryptionKey,
    hasResendCredential: credential !== null,
    paused,
    provider: settings.provider,
    readinessReason: paused
      ? (settings.pausedReasonCode ?? 'paused')
      : readinessReason,
    settings,
  };
};

// --- Provider factory --------------------------------------------------------

export type SenderOverrides = {
  fetchImplementation?: FetchLike;
  sender?: EmailSender;
};

/**
 * Builds the sender for the saved selection only. A missing selected-provider
 * resource is a configuration error; the other provider is never used as an
 * implicit fallback. Credential decryption stays request-scoped.
 */
export const createSenderFromState = async (
  environment: Env,
  state: EmailSettingsState,
  overrides: SenderOverrides = {},
): Promise<EmailSender> => {
  if (overrides.sender !== undefined) {
    return overrides.sender;
  }

  if (state.settings === null || state.settings.provider === 'disabled') {
    throw new CredentialCryptoError(
      'missing_key',
      'No email provider is selected.',
    );
  }

  if (state.settings.provider === 'cloudflare') {
    return createCloudflareEmailSender(environment.EMAIL);
  }

  const credential =
    state.credential ?? (await getEmailCredential(environment, 'resend'));
  if (credential === null) {
    throw new CredentialCryptoError(
      'missing_key',
      'The selected provider has no stored credential.',
    );
  }

  const apiKey = await decryptCredential(
    environment.EMAIL_SETTINGS_ENCRYPTION_KEY ?? '',
    {
      envelope: {
        ciphertext: credential.ciphertext,
        keyVersion: credential.keyVersion,
        nonce: credential.nonce,
      },
      provider: 'resend',
      workspaceId: credential.workspaceId,
    },
  );
  return createResendEmailSender(
    apiKey,
    overrides.fetchImplementation ?? fetch,
  );
};

// --- Self-service preference and history -------------------------------------

export type NotificationPreferenceView = {
  availability: NotificationAvailability;
  newLeadEmail: boolean;
  provider: EmailProvider | null;
};

export const getNotificationPreferenceView = async (
  environment: Env,
  userId: string,
): Promise<NotificationPreferenceView> => {
  const [preference, state] = await Promise.all([
    getNotificationPreference(environment, userId),
    loadEmailSettingsState(environment),
  ]);
  return {
    availability: state.availability,
    newLeadEmail: preference?.newLeadEmail ?? false,
    provider: state.provider,
  };
};

export const updateNotificationPreferenceCommand = (
  environment: Env,
  userId: string,
  newLeadEmail: boolean,
) =>
  Effect.gen(function* () {
    yield* persist(() =>
      upsertNotificationPreference(
        environment,
        userId,
        newLeadEmail,
        new Date(),
      ),
    );
    return yield* persist(() =>
      getNotificationPreferenceView(environment, userId),
    );
  });

const STATUS_LABELS: Record<NotificationStatus, string> = {
  accepted: 'Accepted by email service',
  claimed: 'Pending',
  failed: 'Failed',
  pending: 'Pending',
  retry: 'Retrying',
  sending: 'Pending',
  skipped: 'Skipped',
  unknown: 'Outcome unknown',
};

export const notificationStatusLabel = (status: NotificationStatus): string =>
  STATUS_LABELS[status];

const REASON_LABELS: Record<string, string> = {
  account_disabled: 'Your account was disabled before sending.',
  address_changed: 'Your account email changed before sending.',
  ambiguous: 'The email service outcome is unknown.',
  ambiguous_lease: 'The email service outcome is unknown.',
  concurrent_idempotent_requests:
    'The email service was still processing this message.',
  config_changed: 'The installation configuration changed before sending.',
  expired: 'Expired before sending.',
  expired_ambiguous: 'The email service outcome is unknown.',
  lead_closed: 'The lead was removed before sending.',
  lease_expired: 'The email service outcome is unknown.',
  quota_or_rate_limited:
    'The email service quota was reached; retry is pending.',
  rate_limit_exceeded:
    'The email service rate limit was reached; retry is pending.',
  retry_exhausted: 'Delivery attempts were exhausted.',
  unsubscribed: 'New lead emails were off when the alert was due.',
};

export const notificationReasonLabel = (
  reasonCode: null | string,
): null | string =>
  reasonCode === null
    ? null
    : (REASON_LABELS[reasonCode] ?? 'Delivery needs attention.');

export type NotificationHistoryView = {
  data: NotificationHistoryViewItem[];
  nextCursor: null | string;
};

export type NotificationHistoryViewItem = {
  createdAt: string;
  id: string;
  leadId: string;
  reasonCode: null | string;
  reasonLabel: null | string;
  status: NotificationStatus;
  statusLabel: string;
};

const historyView = (
  page: NotificationHistoryPage,
): NotificationHistoryView => ({
  data: page.items.map((item) => ({
    createdAt: item.createdAt.toISOString(),
    id: item.id,
    leadId: item.leadId,
    reasonCode: item.reasonCode,
    reasonLabel: notificationReasonLabel(item.reasonCode),
    status: item.status,
    statusLabel: notificationStatusLabel(item.status),
  })),
  nextCursor: page.nextCursor,
});

export const listNotificationHistoryCommand = (
  environment: Env,
  userId: string,
  cursor: null | string,
  limit: number,
) =>
  Effect.gen(function* () {
    let keyset: Keyset | null = null;
    if (cursor !== null) {
      keyset = decodeKeysetCursor(cursor);
      if (keyset === null) {
        return yield* Effect.fail(
          domainError(
            'invalid_cursor',
            'cursor is invalid. Use the nextCursor value from a previous response.',
          ),
        );
      }
    }

    const page = yield* persist(() =>
      listNotificationHistory(environment, userId, keyset, limit),
    );
    return historyView(page);
  });

// --- Administrator settings view ---------------------------------------------

export type EmailSettingsView = {
  canonicalOrigin: string;
  enabled: boolean;
  environment: {
    hasCloudflareBinding: boolean;
    hasEncryptionKey: boolean;
  };
  fromEmail: null | string;
  fromName: null | string;
  hasApiKey: boolean;
  paused: null | { at: string; reasonCode: null | string; revision: number };
  provider: 'cloudflare' | 'disabled' | 'resend';
  readiness: {
    availability: NotificationAvailability;
    reasonCode: null | string;
  };
  revision: number;
  test: EmailTestView | null;
};

export type EmailTestView = {
  at: null | string;
  outcome:
    'accepted' | 'ambiguous' | 'configuration_error' | 'rejected' | 'sending';
  providerMessageId: null | string;
  reasonCode: null | string;
  revision: number;
};

const testView = (
  attempt: NotificationTestAttemptRecord | null,
): EmailTestView | null =>
  attempt === null
    ? null
    : {
        at: (attempt.completedAt ?? attempt.createdAt).toISOString(),
        outcome: attempt.status,
        providerMessageId: attempt.providerMessageId,
        reasonCode: attempt.reasonCode,
        revision: attempt.configRevision,
      };

export const getEmailSettingsView = async (
  environment: Env,
  canonicalOriginFallback: string,
): Promise<EmailSettingsView> => {
  const [state, latestTest] = await Promise.all([
    loadEmailSettingsState(environment),
    getLatestNotificationTestAttempt(environment),
  ]);
  const settings = state.settings;
  const pausedAt = settings?.pausedAt ?? settings?.updatedAt;
  const paused =
    settings !== null &&
    settings.pausedRevision !== null &&
    settings.pausedRevision === settings.revision &&
    pausedAt !== undefined
      ? {
          at: pausedAt.toISOString(),
          reasonCode: settings.pausedReasonCode,
          revision: settings.pausedRevision,
        }
      : null;

  return {
    canonicalOrigin: settings?.canonicalOrigin ?? canonicalOriginFallback,
    enabled: settings?.enabled ?? false,
    environment: {
      hasCloudflareBinding: state.hasCloudflareBinding,
      hasEncryptionKey: state.hasEncryptionKey,
    },
    fromEmail: settings?.fromEmail ?? null,
    fromName: settings?.fromName ?? null,
    hasApiKey: state.hasResendCredential,
    paused,
    provider: settings?.provider ?? 'disabled',
    readiness: {
      availability: state.availability,
      reasonCode: state.readinessReason,
    },
    revision: settings?.revision ?? 0,
    test: testView(latestTest),
  };
};

// --- Administrator settings commands -----------------------------------------

export type UpdateEmailSettingsInput = {
  actorUserId: string;
  canonicalOrigin: string;
  credential: {
    operation: 'keep' | 'remove' | 'replace';
    value?: string;
  };
  enabled: boolean;
  expectedRevision: number;
  fromEmail: null | string;
  fromName: null | string;
  provider: 'cloudflare' | 'disabled' | 'resend';
};

const boundedFromName = (value: null | string): null | string => {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length > 120 || /[<>"\\\r\n]/u.test(trimmed)) {
    throw domainError(
      'invalid_from_name',
      'Sender name must be 1-120 characters without angle brackets, quotes, or backslashes.',
    );
  }

  return trimmed;
};

const requireProviderResources = async (
  environment: Env,
  provider: 'cloudflare' | 'disabled' | 'resend',
  credentialOperation: UpdateEmailSettingsInput['credential'],
): Promise<void> => {
  if (provider === 'disabled') {
    return;
  }

  if (provider === 'cloudflare' && environment.EMAIL === undefined) {
    throw domainError(
      'cloudflare_binding_missing',
      'The Cloudflare EMAIL binding is not present in this deployment. Ask the installation owner to add it, or select Resend.',
    );
  }

  if (provider === 'resend' && credentialOperation.operation === 'keep') {
    const credential = await getEmailCredential(environment, 'resend');
    if (credential === null) {
      throw domainError(
        'resend_api_key_missing',
        'Enter a Resend API key to select Resend.',
      );
    }
  }
};

const normalizedFromEmail = (fromEmail: null | string): null | string => {
  if (fromEmail === null || fromEmail.trim().length === 0) {
    return null;
  }

  return fromEmail.trim().toLowerCase();
};

const replaceCredentialEnvelope = (
  environment: Env,
  input: UpdateEmailSettingsInput,
) =>
  Effect.gen(function* () {
    const value = input.credential.value?.trim() ?? '';
    if (
      value.length === 0 ||
      value.length > 512 ||
      !/^[\u0021-\u007E]+$/u.test(value)
    ) {
      return yield* Effect.fail(
        domainError(
          'invalid_api_key',
          'Enter the provider API key (printable characters only).',
        ),
      );
    }

    const secret = environment.EMAIL_SETTINGS_ENCRYPTION_KEY?.trim() ?? '';
    if (secret.length === 0) {
      return yield* Effect.fail(
        domainError(
          'encryption_key_missing',
          'Saving a Resend key requires the EMAIL_SETTINGS_ENCRYPTION_KEY deployment secret. Ask the installation owner to configure it.',
        ),
      );
    }

    return yield* Effect.tryPromise({
      catch: (cause) => {
        if (cause instanceof CredentialCryptoError) {
          return domainError(
            cause.code === 'invalid_key'
              ? 'encryption_key_invalid'
              : cause.code,
            'The email credential could not be encrypted with the configured key.',
          );
        }

        return domainError(
          'encryption_failed',
          'The email credential could not be encrypted.',
        );
      },
      try: () =>
        encryptCredential(secret, {
          provider: 'resend',
          value,
          workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        }),
    });
  });

const viewAfterSave = (
  environment: Env,
  input: UpdateEmailSettingsInput,
  outcome: Awaited<ReturnType<typeof saveEmailSettings>>,
) =>
  Effect.gen(function* () {
    if (outcome.kind === 'conflict') {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    return yield* persist(() =>
      getEmailSettingsView(environment, input.canonicalOrigin),
    );
  });

export const updateEmailSettingsCommand = (
  environment: Env,
  input: UpdateEmailSettingsInput,
) =>
  Effect.gen(function* () {
    const fromEmail = normalizedFromEmail(input.fromEmail);
    if (input.provider !== 'disabled' && fromEmail === null) {
      return yield* Effect.fail(
        domainError(
          'from_email_required',
          'Enter the sender address that notifications are sent from.',
        ),
      );
    }

    const fromName = yield* Effect.try({
      catch: (cause) =>
        cause instanceof DomainError
          ? cause
          : domainError('invalid_input', 'The submitted data is invalid.'),
      try: () => boundedFromName(input.fromName),
    });

    if (input.credential.operation === 'replace') {
      const envelope = yield* replaceCredentialEnvelope(environment, input);
      const replaced = yield* persist(() =>
        saveEmailSettings(environment, {
          actorUserId: input.actorUserId,
          canonicalOrigin: input.canonicalOrigin,
          credentialChange: { envelope, operation: 'replace' },
          enabled: input.enabled,
          expectedRevision: input.expectedRevision,
          fromEmail,
          fromName,
          now: new Date(),
          provider: input.provider,
        }),
      );
      return yield* viewAfterSave(environment, input, replaced);
    }

    yield* persist(() =>
      requireProviderResources(environment, input.provider, input.credential),
    );
    const saved = yield* persist(() =>
      saveEmailSettings(environment, {
        actorUserId: input.actorUserId,
        canonicalOrigin: input.canonicalOrigin,
        credentialChange:
          input.credential.operation === 'remove'
            ? { operation: 'remove' }
            : { operation: 'keep' },
        enabled: input.enabled,
        expectedRevision: input.expectedRevision,
        fromEmail,
        fromName,
        now: new Date(),
        provider: input.provider,
      }),
    );
    return yield* viewAfterSave(environment, input, saved);
  });

// --- Administrator test email ------------------------------------------------

export type SendTestEmailInput = {
  actorEmail: string;
  actorUserId: string;
  canonicalOrigin: string;
  expectedRevision: number;
  requestId: string;
};

const canReplayTest = (
  attempt: NotificationTestAttemptRecord,
  now: Date,
): boolean => {
  if (attempt.provider !== 'resend' || attempt.status === 'accepted') {
    return false;
  }

  const retryable =
    attempt.status === 'ambiguous' ||
    (attempt.status === 'rejected' &&
      attempt.reasonCode !== null &&
      RETRYABLE_TEST_REASONS.has(attempt.reasonCode));
  if (!retryable) {
    return false;
  }

  const deadline =
    attempt.createdAt.getTime() +
    NOTIFICATION_EVENT_TTL_MS -
    RESEND_IDEMPOTENCY_SAFETY_MS;
  return now.getTime() < deadline;
};

const finishStoredTest = (
  attempt: NotificationTestAttemptRecord,
): EmailTestView =>
  testView(attempt) ?? {
    at: attempt.createdAt.toISOString(),
    outcome: attempt.status,
    providerMessageId: null,
    reasonCode: null,
    revision: attempt.configRevision,
  };

const completionForTestResult = (
  result: SendResult,
): {
  pause: boolean;
  reasonCode: null | string;
  status: 'accepted' | 'ambiguous' | 'rejected';
} => {
  if (result.kind === 'accepted') {
    return { pause: false, reasonCode: null, status: 'accepted' };
  }

  if (result.kind === 'ambiguous') {
    return { pause: false, reasonCode: result.reason, status: 'ambiguous' };
  }

  const recipientOnly = RECIPIENT_REJECTION_REASONS.has(result.reason);
  return {
    pause: !result.retryable && !recipientOnly,
    reasonCode: result.reason,
    status: 'rejected',
  };
};

const completeTest = async (
  environment: Env,
  input: SendTestEmailInput,
  revision: number,
  now: Date,
  completion: {
    providerMessageId?: null | string;
    reasonCode: null | string;
    status: 'accepted' | 'ambiguous' | 'configuration_error' | 'rejected';
  },
): Promise<void> => {
  await completeNotificationTestAttempt(environment, {
    completedAt: now,
    providerMessageId: completion.providerMessageId ?? null,
    reasonCode: completion.reasonCode,
    requestId: input.requestId,
    status: completion.status,
  });
  await recordEmailSettingsAudit(environment, {
    action: 'test_email',
    actorUserId: input.actorUserId,
    now,
    reasonCode: completion.reasonCode,
    revision,
    testOutcome: completion.status,
  });
};

const reserveTest = (
  environment: Env,
  settings: EmailSettingsRecord,
  input: SendTestEmailInput,
  now: Date,
) =>
  Effect.gen(function* () {
    if (settings.provider === 'disabled') {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    const reservation = yield* persist(() =>
      reserveNotificationTestAttempt(environment, {
        configRevision: settings.revision,
        now,
        requestId: input.requestId,
        userId: input.actorUserId,
      }),
    );
    if (reservation === 'rate_limited') {
      return yield* Effect.fail(
        domainError(
          'test_rate_limited',
          'A test email was sent within the last minute. Try again shortly.',
          { retryAfterSeconds: 60 },
        ),
      );
    }

    if (reservation === 'daily_limited') {
      return yield* Effect.fail(
        domainError(
          'test_daily_limited',
          'The daily limit of five test emails has been reached.',
          { retryAfterSeconds: 86_400 },
        ),
      );
    }

    return reservation;
  });

const sendAndRecordTest = async (
  environment: Env,
  state: EmailSettingsState,
  input: SendTestEmailInput,
  overrides: SenderOverrides,
): Promise<EmailTestView> => {
  const settings = state.settings;
  if (settings === null) {
    throw new Error('The email settings disappeared during a test.');
  }

  const now = new Date();
  const origin = settings.canonicalOrigin ?? input.canonicalOrigin;
  const rendered = renderTestEmail({ origin });
  const envelope: EmailEnvelope = {
    from: {
      email: settings.fromEmail ?? '',
      ...(settings.fromName === null ? {} : { name: settings.fromName }),
    },
    html: rendered.html,
    subject: rendered.subject,
    text: rendered.text,
    to: input.actorEmail,
  };
  const provider = settings.provider === 'disabled' ? null : settings.provider;
  if (provider === null) {
    throw new Error('No provider is selected.');
  }

  const frozen = await freezeNotificationTestAttempt(environment, {
    configRevision: settings.revision,
    deliveryKey: testDeliveryKeyFor(input.requestId),
    envelopeJson: serializeEnvelope(envelope),
    now,
    provider,
    requestId: input.requestId,
  });
  if (!frozen) {
    const current = await getNotificationTestAttempt(
      environment,
      input.requestId,
    );
    if (current === null) {
      throw new Error('The test attempt disappeared.');
    }

    return finishStoredTest(current);
  }

  let sender: EmailSender;
  try {
    sender = await createSenderFromState(environment, state, overrides);
  } catch {
    await completeTest(environment, input, settings.revision, now, {
      reasonCode: 'provider_unavailable',
      status: 'configuration_error',
    });
    const current = await getNotificationTestAttempt(
      environment,
      input.requestId,
    );
    if (current === null) {
      throw new Error('The test attempt disappeared.');
    }

    return finishStoredTest(current);
  }

  let result: SendResult;
  try {
    result = await sender.send(envelope, {
      deliveryKey: testDeliveryKeyFor(input.requestId),
    });
  } catch {
    result = { kind: 'ambiguous', provider, reason: 'unexpected' };
  }

  const completion = completionForTestResult(result);
  await completeTest(environment, input, settings.revision, now, {
    providerMessageId:
      result.kind === 'accepted' ? (result.messageId ?? null) : null,
    reasonCode: completion.reasonCode,
    status: completion.status,
  });
  if (completion.pause) {
    await recordEmailSettingsConfigError(environment, {
      now,
      reasonCode: completion.reasonCode ?? 'provider_error',
      revision: settings.revision,
    });
  } else if (completion.status === 'accepted') {
    await clearEmailSettingsPause(environment, settings.revision, now);
  }

  const latest = await getNotificationTestAttempt(environment, input.requestId);
  if (latest === null) {
    throw new Error('The test attempt disappeared.');
  }

  return finishStoredTest(latest);
};

export const sendTestEmailCommand = (
  environment: Env,
  input: SendTestEmailInput,
  overrides: SenderOverrides & { now?: () => Date } = {},
) =>
  Effect.gen(function* () {
    const now = overrides.now?.() ?? new Date();
    const settings = yield* persist(() => getEmailSettings(environment));
    if (settings === null || settings.revision !== input.expectedRevision) {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    const state = yield* persist(() => loadEmailSettingsState(environment));
    if (state.availability === 'disabled') {
      return yield* Effect.fail(
        domainError(
          'email_disabled',
          'Choose a provider and enable email before sending a test.',
        ),
      );
    }

    if (state.availability === 'misconfigured') {
      return yield* Effect.fail(
        domainError(
          'email_misconfigured',
          'Complete the saved provider configuration before sending a test.',
        ),
      );
    }

    const existing = yield* persist(() =>
      getNotificationTestAttempt(environment, input.requestId),
    );
    if (existing === null) {
      yield* reserveTest(environment, settings, input, now);
    } else if (!canReplayTest(existing, now)) {
      return finishStoredTest(existing);
    }

    return yield* persist(() =>
      sendAndRecordTest(environment, state, input, overrides),
    );
  });

// --- Delivery state machine --------------------------------------------------

export type ProcessNotificationOptions = SenderOverrides & {
  now?: () => Date;
  random?: () => number;
  randomToken?: () => string;
  timeBudgetMs?: number;
};

export type ProcessNotificationOutcome =
  | { kind: 'accepted'; messageId: null | string; outboxId: string }
  | { kind: 'disabled'; reasonCode: string }
  | { kind: 'failed'; outboxId: string; reasonCode: string }
  | { kind: 'idle' }
  | { kind: 'misconfigured'; reasonCode: string }
  | { kind: 'paused'; reasonCode: string }
  | { kind: 'retry'; nextAttemptAt: Date; outboxId: string }
  | { kind: 'skipped'; outboxId: string; reasonCode: string }
  | { kind: 'unknown'; outboxId: string; reasonCode: string };

type Finish = (completion: NotificationCompletion) => Promise<void>;

const randomToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const backoffMs = (attempt: number, random: () => number): number => {
  const base =
    (RETRY_BACKOFF_SECONDS[
      Math.min(attempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
    ] ?? 21_600) * 1_000;
  const jitter = Math.floor(base * 0.1 * random());
  return base + jitter;
};

const ambiguityReason = (reasonCode: null | string): boolean =>
  reasonCode === 'ambiguous' || reasonCode === 'ambiguous_lease';

const ackWithRetry = async (
  acknowledge: () => Promise<boolean>,
): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (await acknowledge()) {
        return true;
      }
    } catch {
      // Try the acknowledgement again only; the sender is never re-invoked
      // from this attempt.
    }
  }

  return false;
};

const eligibilityVerdict = (
  row: { recipientEmail: string },
  eligibility: Awaited<ReturnType<typeof getNotificationEligibility>>,
): null | { reasonCode: string; status: NotificationStatus } => {
  if (eligibility === null || !eligibility.userExists) {
    return { reasonCode: 'account_disabled', status: 'skipped' };
  }

  if (eligibility.disabledAt !== null) {
    return { reasonCode: 'account_disabled', status: 'skipped' };
  }

  if (eligibility.newLeadEmail !== true) {
    return { reasonCode: 'unsubscribed', status: 'skipped' };
  }

  if (
    eligibility.currentEmail === null ||
    eligibility.currentEmail.trim().toLowerCase() !== row.recipientEmail
  ) {
    return { reasonCode: 'address_changed', status: 'skipped' };
  }

  if (!eligibility.leadExists || eligibility.leadDeletedAt !== null) {
    return { reasonCode: 'lead_closed', status: 'skipped' };
  }

  return null;
};

const availabilityOutcome = async (
  environment: Env,
  state: EmailSettingsState,
  now: Date,
): Promise<null | ProcessNotificationOutcome> => {
  if (state.availability === 'disabled') {
    return { kind: 'disabled', reasonCode: 'disabled' };
  }

  if (state.availability === 'configured') {
    return null;
  }

  const reasonCode = state.readinessReason ?? state.availability;
  await recordNotificationDispatchConfigError(environment, {
    code: reasonCode,
    revision: state.settings?.revision ?? null,
    timestamp: now,
  });
  return state.availability === 'unavailable'
    ? { kind: 'paused', reasonCode }
    : { kind: 'misconfigured', reasonCode };
};

type EarlyCompletion = {
  completion: NotificationCompletion;
  outcome: ProcessNotificationOutcome;
};

/**
 * Terminal rechecks that run after the claim: recipient eligibility, event
 * age, configuration pinning, and attempt exhaustion. Every branch returns an
 * honest, reason-coded completion; none of them contacts a provider.
 */
const earlyCompletion = async (
  environment: Env,
  row: NotificationOutboxRecord,
  settings: EmailSettingsRecord,
  now: Date,
): Promise<EarlyCompletion | null> => {
  const eligibility = await getNotificationEligibility(environment, row);
  const verdict = eligibilityVerdict(row, eligibility);
  if (verdict !== null) {
    return {
      completion: { reasonCode: verdict.reasonCode, status: verdict.status },
      outcome: {
        kind: 'skipped',
        outboxId: row.id,
        reasonCode: verdict.reasonCode,
      },
    };
  }

  if (now.getTime() - row.createdAt.getTime() >= NOTIFICATION_EVENT_TTL_MS) {
    const ambiguous = row.attemptCount > 0 && ambiguityReason(row.reasonCode);
    return {
      completion: {
        reasonCode: ambiguous ? 'expired_ambiguous' : 'expired',
        status: ambiguous ? 'unknown' : 'skipped',
      },
      outcome: {
        kind: ambiguous ? 'unknown' : 'skipped',
        outboxId: row.id,
        reasonCode: ambiguous ? 'expired_ambiguous' : 'expired',
      },
    };
  }

  if (
    row.attemptCount > 0 &&
    row.configRevision !== null &&
    row.configRevision !== settings.revision
  ) {
    return {
      completion: { reasonCode: 'config_changed', status: 'unknown' },
      outcome: {
        kind: 'unknown',
        outboxId: row.id,
        reasonCode: 'config_changed',
      },
    };
  }

  if (row.attemptCount >= NOTIFICATION_MAX_ATTEMPTS) {
    const ambiguous = ambiguityReason(row.reasonCode);
    return {
      completion: {
        reasonCode: ambiguous ? 'ambiguous_exhausted' : 'retry_exhausted',
        status: ambiguous ? 'unknown' : 'failed',
      },
      outcome: {
        kind: ambiguous ? 'unknown' : 'failed',
        outboxId: row.id,
        reasonCode: ambiguous ? 'ambiguous_exhausted' : 'retry_exhausted',
      },
    };
  }

  return null;
};

type PreparedAttempt =
  | {
      deliveryKey: string;
      envelope: EmailEnvelope;
      idempotencyDeadline: Date | null;
      kind: 'ready';
      payloadHash: string;
      provider: EmailProvider;
    }
  | { kind: 'frozen_payload_invalid' }
  | { kind: 'provider_missing' };

/**
 * Rebuilds the exact frozen attempt. Retries never re-render the envelope or
 * choose a new key: provider, delivery key, payload, and hash are pinned to
 * the first attempt.
 */
const prepareAttempt = async (
  row: NotificationOutboxRecord,
  settings: EmailSettingsRecord,
  now: Date,
): Promise<PreparedAttempt> => {
  const provider = row.provider ?? settings.provider;
  if (provider === 'disabled') {
    return { kind: 'provider_missing' };
  }

  let envelope: EmailEnvelope;
  if (row.frozenEnvelopeJson === null) {
    const rendered = renderNewLeadNotification({
      leadId: row.leadId,
      origin: settings.canonicalOrigin ?? 'https://localhost',
    });
    envelope = {
      from: {
        email: settings.fromEmail ?? '',
        ...(settings.fromName === null ? {} : { name: settings.fromName }),
      },
      html: rendered.html,
      subject: rendered.subject,
      text: rendered.text,
      to: row.recipientEmail,
    };
  } else {
    const parsed = parseEnvelope(row.frozenEnvelopeJson);
    if (parsed === null) {
      return { kind: 'frozen_payload_invalid' };
    }

    envelope = parsed;
  }

  const idempotencyDeadline =
    row.idempotencyDeadline ??
    (provider === 'resend'
      ? new Date(
          Math.min(
            now.getTime() +
              NOTIFICATION_EVENT_TTL_MS -
              RESEND_IDEMPOTENCY_SAFETY_MS,
            row.createdAt.getTime() + NOTIFICATION_EVENT_TTL_MS,
          ),
        )
      : null);

  return {
    deliveryKey: row.deliveryKey ?? deliveryKeyFor(row.id),
    envelope,
    idempotencyDeadline,
    kind: 'ready',
    payloadHash: row.payloadHash ?? (await envelopePayloadHash(envelope)),
    provider,
  };
};

const recordSendResult = async (
  environment: Env,
  row: NotificationOutboxRecord,
  settings: EmailSettingsRecord,
  prepared: Extract<PreparedAttempt, { kind: 'ready' }>,
  now: Date,
  result: SendResult,
  finish: Finish,
  options: ProcessNotificationOptions,
): Promise<ProcessNotificationOutcome> => {
  if (result.kind === 'accepted') {
    await finish({
      acceptedAt: now,
      providerMessageId: result.messageId ?? null,
      reasonCode: null,
      status: 'accepted',
    });
    await recordNotificationDispatchSuccess(environment, now);
    return {
      kind: 'accepted',
      messageId: result.messageId ?? null,
      outboxId: row.id,
    };
  }

  if (result.kind === 'ambiguous') {
    const retryableResend =
      prepared.provider === 'resend' &&
      prepared.idempotencyDeadline !== null &&
      now.getTime() < prepared.idempotencyDeadline.getTime();
    if (retryableResend) {
      await finish({ reasonCode: 'ambiguous', status: 'retry' });
      return {
        kind: 'retry',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        outboxId: row.id,
      };
    }

    await finish({ reasonCode: result.reason, status: 'unknown' });
    return { kind: 'unknown', outboxId: row.id, reasonCode: result.reason };
  }

  // Definite rejection. Recipient-specific failures terminate this one row;
  // a persistent provider-configuration failure also pauses the revision.
  const recipientOnly = RECIPIENT_REJECTION_REASONS.has(result.reason);
  const nextAttempt = row.attemptCount + 1;
  const exhausted = nextAttempt >= NOTIFICATION_MAX_ATTEMPTS;
  if (result.retryable && !exhausted) {
    const retryAfterMs = (result.retryAfterSeconds ?? 0) * 1_000;
    const delay = Math.max(
      backoffMs(nextAttempt, options.random ?? Math.random),
      retryAfterMs,
    );
    const nextAttemptAt = new Date(now.getTime() + delay);
    await finish({
      nextAttemptAt,
      reasonCode: result.reason,
      status: 'retry',
    });
    return { kind: 'retry', nextAttemptAt, outboxId: row.id };
  }

  const reasonCode = exhausted ? 'retry_exhausted' : result.reason;
  await finish({ reasonCode, status: 'failed' });
  if (!result.retryable && !recipientOnly) {
    await recordEmailSettingsConfigError(environment, {
      now,
      reasonCode: result.reason,
      revision: settings.revision,
    });
  }

  return { kind: 'failed', outboxId: row.id, reasonCode };
};

type SendAttempt =
  | { kind: 'failure'; outcome: ProcessNotificationOutcome }
  | { kind: 'sent'; result: SendResult };

const sendPreparedAttempt = async (
  environment: Env,
  state: EmailSettingsState,
  settings: EmailSettingsRecord,
  row: NotificationOutboxRecord,
  prepared: Extract<PreparedAttempt, { kind: 'ready' }>,
  options: ProcessNotificationOptions,
  finish: Finish,
  now: Date,
): Promise<SendAttempt> => {
  let sender: EmailSender;
  try {
    sender = await createSenderFromState(environment, state, options);
  } catch (error) {
    const reasonCode =
      error instanceof CredentialCryptoError
        ? error.code
        : 'provider_unavailable';
    await finish({ reasonCode, status: 'retry' });
    await recordEmailSettingsConfigError(environment, {
      now,
      reasonCode,
      revision: settings.revision,
    });
    return {
      kind: 'failure',
      outcome: { kind: 'misconfigured', reasonCode },
    };
  }

  await renewNotificationLease(environment, {
    leaseMs: NOTIFICATION_LEASE_MS,
    leaseToken: row.leaseToken ?? '',
    outboxId: row.id,
    timestamp: now,
  });

  try {
    return {
      kind: 'sent',
      result: await sender.send(prepared.envelope, {
        deliveryKey: prepared.deliveryKey,
      }),
    };
  } catch {
    return {
      kind: 'sent',
      result: {
        kind: 'ambiguous',
        provider: prepared.provider,
        reason: 'unexpected_error',
      },
    };
  }
};

/**
 * Processes at most one due notification. The order is deliberate: local
 * readiness, durable claim, terminal rechecks, freeze, send, fenced
 * acknowledgement. The external call is never part of the intake transaction
 * and a stale lease holder cannot overwrite its successor.
 */
export const processNextNotification = async (
  environment: Env,
  options: ProcessNotificationOptions = {},
): Promise<ProcessNotificationOutcome> => {
  const now = options.now?.() ?? new Date();
  const state = await loadEmailSettingsState(environment);
  const gated = await availabilityOutcome(environment, state, now);
  if (gated !== null) {
    return gated;
  }

  const settings = state.settings;
  if (settings === null) {
    return { kind: 'disabled', reasonCode: 'disabled' };
  }

  const leaseToken = options.randomToken?.() ?? randomToken();
  const row = await claimNextNotification(
    environment,
    now,
    leaseToken,
    NOTIFICATION_LEASE_MS,
  );
  if (row === null) {
    return { kind: 'idle' };
  }

  const finish: Finish = async (completion) => {
    await ackWithRetry(() =>
      completeNotificationAttempt(environment, {
        completion,
        leaseToken,
        outboxId: row.id,
        timestamp: now,
      }),
    );
  };

  const early = await earlyCompletion(environment, row, settings, now);
  if (early !== null) {
    await finish(early.completion);
    return early.outcome;
  }

  const prepared = await prepareAttempt(row, settings, now);
  if (prepared.kind === 'provider_missing') {
    await finish({ reasonCode: 'provider_unavailable', status: 'unknown' });
    return {
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: 'provider_unavailable',
    };
  }

  if (prepared.kind === 'frozen_payload_invalid') {
    await finish({ reasonCode: 'frozen_payload_invalid', status: 'failed' });
    return {
      kind: 'failed',
      outboxId: row.id,
      reasonCode: 'frozen_payload_invalid',
    };
  }

  const frozen = await freezeNotificationAttempt(environment, {
    configRevision: settings.revision,
    deliveryKey: prepared.deliveryKey,
    envelopeJson: serializeEnvelope(prepared.envelope),
    idempotencyDeadline: prepared.idempotencyDeadline,
    leaseMs: NOTIFICATION_LEASE_MS,
    leaseToken,
    outboxId: row.id,
    payloadHash: prepared.payloadHash,
    provider: prepared.provider,
    timestamp: now,
  });
  if (!frozen) {
    return { kind: 'idle' };
  }

  const send = await sendPreparedAttempt(
    environment,
    state,
    settings,
    row,
    prepared,
    options,
    finish,
    now,
  );
  if (send.kind === 'failure') {
    return send.outcome;
  }

  return recordSendResult(
    environment,
    row,
    settings,
    prepared,
    now,
    send.result,
    finish,
    options,
  );
};

// --- Bounded scheduled dispatch ---------------------------------------------

export type NotificationDispatchResult = {
  outcomes: ProcessNotificationOutcome[];
  processed: number;
  stopped: 'idle' | 'limit' | 'time' | 'unavailable';
};

/**
 * One bounded scheduling unit: record the tick, recover expired leases and
 * stale events, then process at most `batchLimit` due notifications while
 * leaving time for acknowledgement. The default of one message per tick keeps
 * CPU headroom on Workers Free.
 */
export const runNotificationDispatch = async (
  environment: Env,
  options: ProcessNotificationOptions & {
    batchLimit?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<NotificationDispatchResult> => {
  const now = options.now?.() ?? new Date();
  const startedAt = Date.now();
  const budget = options.timeBudgetMs ?? DISPATCH_TIME_BUDGET_MS;
  const limit = options.batchLimit ?? DISPATCH_BATCH_LIMIT;
  await recordNotificationDispatchTick(environment, now);
  await recoverExpiredNotificationLeases(environment, now);
  await expireStaleNotificationIntents(
    environment,
    new Date(now.getTime() - NOTIFICATION_EVENT_TTL_MS),
    now,
  );
  await cleanupResolvedNotificationRows(
    environment,
    new Date(now.getTime() - NOTIFICATION_RETENTION_MS),
    100,
  );

  const outcomes: ProcessNotificationOutcome[] = [];
  for (let processed = 0; processed < limit; processed += 1) {
    if (Date.now() - startedAt > budget) {
      return { outcomes, processed, stopped: 'time' };
    }

    const outcome = await processNextNotification(environment, options);
    outcomes.push(outcome);
    switch (outcome.kind) {
      case 'disabled': {
        return { outcomes, processed, stopped: 'unavailable' };
      }

      case 'idle': {
        return { outcomes, processed, stopped: 'idle' };
      }

      case 'misconfigured': {
        return { outcomes, processed, stopped: 'unavailable' };
      }

      case 'paused': {
        return { outcomes, processed, stopped: 'unavailable' };
      }

      default: {
        break;
      }
    }
  }

  return { outcomes, processed: outcomes.length, stopped: 'limit' };
};
