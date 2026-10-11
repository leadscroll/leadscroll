/**
 * Application commands for new-lead email notifications.
 *
 * Business rules live here per the repository boundary: recipient
 * availability, provider selection, credential decryption, the fenced
 * delivery state machine, administrator settings/test sends, and bounded
 * scheduled dispatch. Repository modules own D1 access; provider adapters own
 * provider-specific wire behavior.
 */

import { logNotificationDispatchOutcome } from '@/api/logging';
import { DomainError, PersistenceError } from '@/application/errors';
import {
  claimNextNotification,
  cleanupResolvedNotificationRows,
  clearEmailSettingsPause,
  completeNotificationAttempt,
  completeNotificationTestAttempt,
  type EmailCredentialRecord,
  type EmailSettingsRecord,
  type EmailSettingsSnapshot,
  type Env,
  expireStaleNotificationIntents,
  freezeNotificationAttempt,
  freezeNotificationTestAttempt,
  getEmailCredential,
  getEmailSettingsSnapshot,
  getLatestNotificationTestAttempt,
  getNotificationDispatchHealth,
  getNotificationEligibility,
  getNotificationOutboxRow,
  getNotificationPreference,
  getNotificationTestAttempt,
  getOwnedNotificationTestAttempt,
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
  type EmailSettingsView,
  type EmailTestView,
  type NotificationHistoryView,
  type NotificationPreferenceView,
} from '@/domain/schemas';
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
 * Derives local readiness from one coherent settings/credential snapshot.
 * `configured` means the saved selection has the resources it needs as far as
 * this deployment can tell; it is never evidence of remote entitlement or an
 * accepted test message.
 */
const stateFromSnapshot = (
  environment: Env,
  snapshot: EmailSettingsSnapshot,
): EmailSettingsState => {
  const { credential, settings } = snapshot;
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

  const selectedCredential = settings.provider === 'resend' ? credential : null;
  const paused =
    settings.pausedRevision !== null &&
    settings.pausedRevision === settings.revision;
  const readinessReason = configuredReadiness(
    { credential: selectedCredential, hasCloudflareBinding, hasEncryptionKey },
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
    credential: selectedCredential,
    hasCloudflareBinding,
    hasEncryptionKey,
    hasResendCredential: selectedCredential !== null,
    paused,
    provider: settings.provider,
    readinessReason: paused
      ? (settings.pausedReasonCode ?? 'paused')
      : readinessReason,
    settings,
  };
};

export const loadEmailSettingsState = async (
  environment: Env,
): Promise<EmailSettingsState> =>
  stateFromSnapshot(environment, await getEmailSettingsSnapshot(environment));

export type SavedConfigurationTest =
  { code: string; message: string; ok: false } | { ok: true };

/**
 * Whether the *saved* provider configuration can produce a test message.
 * Notification delivery being paused or switched off does not block an
 * explicit test: testing is how a paused revision recovers, and configuration
 * checks must not force live alerts on.
 */
export const savedConfigurationTestable = (
  state: EmailSettingsState,
): SavedConfigurationTest => {
  const settings = state.settings;
  if (settings === null || settings.provider === 'disabled') {
    return {
      code: 'email_disabled',
      message: 'Choose a provider before sending a test.',
      ok: false,
    };
  }

  if (settings.fromEmail === null || settings.fromEmail.trim().length === 0) {
    return {
      code: 'email_misconfigured',
      message: 'Set the sender address before sending a test.',
      ok: false,
    };
  }

  if (settings.provider === 'cloudflare' && !state.hasCloudflareBinding) {
    return {
      code: 'email_misconfigured',
      message:
        'The Cloudflare EMAIL binding is not present in this deployment.',
      ok: false,
    };
  }

  if (settings.provider === 'resend' && !state.hasResendCredential) {
    return {
      code: 'email_misconfigured',
      message: 'Add the Resend API key before sending a test.',
      ok: false,
    };
  }

  if (settings.provider === 'resend' && !state.hasEncryptionKey) {
    return {
      code: 'email_misconfigured',
      message: 'The credential encryption key is not configured.',
      ok: false,
    };
  }

  return { ok: true };
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

const dispatchHealthView = (
  health: Awaited<ReturnType<typeof getNotificationDispatchHealth>>,
): EmailSettingsView['dispatch'] => ({
  configError:
    health.dispatch === null || health.dispatch.configErrorCode === null
      ? null
      : {
          at: (
            health.dispatch.configErrorAt ?? health.dispatch.updatedAt
          ).toISOString(),
          code: health.dispatch.configErrorCode,
          revision: health.dispatch.configErrorRevision,
        },
  inFlight: health.inFlight,
  lastSuccessAt: health.dispatch?.lastSuccessAt?.toISOString() ?? null,
  lastTickAt: health.dispatch?.lastTickAt?.toISOString() ?? null,
  oldestDueAt: health.oldestDueAt?.toISOString() ?? null,
  pending: health.pending,
  unknown: health.unknown,
});

export const getEmailSettingsView = async (
  environment: Env,
  canonicalOriginFallback: string,
): Promise<EmailSettingsView> => {
  const [health, latestTest, state] = await Promise.all([
    getNotificationDispatchHealth(environment),
    getLatestNotificationTestAttempt(environment),
    loadEmailSettingsState(environment),
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
    dispatch: dispatchHealthView(health),
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

/**
 * Bounded work per tick for lease recovery, expiry, and retention cleanup.
 */
export const MAINTENANCE_BATCH_LIMIT = 100;

/**
 * Failed provider reasons that evidence a persistent installation
 * configuration problem. Anything else (recipient, payload, idempotency, or
 * an unrecognized provider failure) ends that one item without pausing the
 * whole installation.
 */
const CONFIGURATION_FAILURE_REASONS = new Set([
  'cloudflare_binding_missing',
  'decrypt_failed',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_SENDER_NOT_VERIFIED',
  'encryption_key_invalid',
  'encryption_key_missing',
  'invalid_api_key',
  'invalid_permission',
  'missing_api_key',
  'provider_unavailable',
  'resend_api_key_missing',
  'restricted_api_key',
  'suspended_api_key',
]);

const testAttemptDeadlineAt = (createdAt: Date): Date =>
  new Date(
    createdAt.getTime() +
      NOTIFICATION_EVENT_TTL_MS -
      RESEND_IDEMPOTENCY_SAFETY_MS,
  );

/**
 * Compares a stored test attempt with the saved configuration and the caller.
 * A non-null result means the request id can no longer be replayed: reusing it
 * must not rebuild the message with a different provider, account, sender, or
 * recipient.
 */
const testAttemptConflict = (
  attempt: NotificationTestAttemptRecord,
  state: EmailSettingsState,
  input: SendTestEmailInput,
): null | string => {
  if (attempt.userId !== input.actorUserId) {
    return 'owner';
  }

  if (attempt.provider === null) {
    // A concurrent reservation has not frozen its identity yet; the caller
    // reports the durable in-progress state instead of replaying it.
    return null;
  }

  const settings = state.settings;
  if (settings === null) {
    return 'configuration';
  }

  if (attempt.configRevision !== settings.revision) {
    return 'revision';
  }

  if (attempt.provider !== settings.provider) {
    return 'provider';
  }

  if (attempt.deliveryKey !== testDeliveryKeyFor(input.requestId)) {
    return 'key';
  }

  const envelope =
    attempt.frozenEnvelopeJson === null
      ? null
      : parseEnvelope(attempt.frozenEnvelopeJson);
  if (envelope === null) {
    return 'payload';
  }

  if (
    envelope.to.trim().toLowerCase() !== input.actorEmail.trim().toLowerCase()
  ) {
    return 'recipient';
  }

  return null;
};

const canReplayTest = (
  attempt: NotificationTestAttemptRecord,
  state: EmailSettingsState,
  input: SendTestEmailInput,
  now: Date,
): boolean => {
  if (
    attempt.provider !== 'resend' ||
    attempt.status === 'accepted' ||
    state.settings === null
  ) {
    return false;
  }

  const retryable =
    attempt.status === 'ambiguous' ||
    (attempt.status === 'rejected' &&
      attempt.reasonCode !== null &&
      RETRYABLE_TEST_REASONS.has(attempt.reasonCode));
  if (!retryable || testAttemptConflict(attempt, state, input) !== null) {
    return false;
  }

  return now.getTime() < testAttemptDeadlineAt(attempt.createdAt).getTime();
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

  return {
    pause: CONFIGURATION_FAILURE_REASONS.has(result.reason),
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
    userId: input.actorUserId,
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

const buildTestEnvelope = (
  settings: EmailSettingsRecord,
  input: SendTestEmailInput,
): EmailEnvelope => {
  const rendered = renderTestEmail({
    origin: settings.canonicalOrigin ?? input.canonicalOrigin,
  });
  return {
    from: {
      email: settings.fromEmail ?? '',
      ...(settings.fromName === null ? {} : { name: settings.fromName }),
    },
    html: rendered.html,
    subject: rendered.subject,
    text: rendered.text,
    to: input.actorEmail.trim().toLowerCase(),
  };
};

const reReadTest = async (
  environment: Env,
  input: SendTestEmailInput,
): Promise<EmailTestView> => {
  const current = await getOwnedNotificationTestAttempt(
    environment,
    input.requestId,
    input.actorUserId,
  );
  if (current === null) {
    throw new Error('The test attempt disappeared.');
  }

  return finishStoredTest(current);
};

/**
 * Sends one explicit administrator test. On a replayable attempt the stored
 * envelope and key are reused byte for byte; a changed provider, account,
 * sender, recipient, or template revision is a conflict, never a new send.
 */
const sendAndRecordTest = async (
  environment: Env,
  state: EmailSettingsState,
  input: SendTestEmailInput,
  overrides: SenderOverrides,
  now: Date,
  existing: NotificationTestAttemptRecord | null,
): Promise<EmailTestView> => {
  const settings = state.settings;
  if (settings === null) {
    throw new Error('The email settings disappeared during a test.');
  }

  const provider = settings.provider === 'disabled' ? null : settings.provider;
  if (provider === null) {
    throw new Error('No provider is selected.');
  }

  const storedJson = existing?.frozenEnvelopeJson ?? null;
  const storedEnvelope = storedJson === null ? null : parseEnvelope(storedJson);
  const envelope = storedEnvelope ?? buildTestEnvelope(settings, input);
  const deliveryKey =
    existing?.deliveryKey ?? testDeliveryKeyFor(input.requestId);

  // Build the sender from the coherent snapshot before the freeze boundary, so
  // the external call can never use a credential saved after the freeze.
  let sender: EmailSender;
  try {
    sender = await createSenderFromState(environment, state, overrides);
  } catch {
    await completeTest(environment, input, settings.revision, now, {
      reasonCode: 'provider_unavailable',
      status: 'configuration_error',
    });
    return reReadTest(environment, input);
  }

  const frozen = await freezeNotificationTestAttempt(environment, {
    configRevision: existing?.configRevision ?? settings.revision,
    deliveryKey,
    envelopeJson: serializeEnvelope(envelope),
    now,
    provider: existing?.provider ?? provider,
    requestId: input.requestId,
    userId: input.actorUserId,
  });
  if (!frozen) {
    return reReadTest(environment, input);
  }

  let result: SendResult;
  try {
    result = await sender.send(envelope, { deliveryKey });
  } catch {
    result = {
      kind: 'ambiguous',
      provider: existing?.provider ?? provider,
      reason: 'unexpected',
    };
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

  return reReadTest(environment, input);
};

export const sendTestEmailCommand = (
  environment: Env,
  input: SendTestEmailInput,
  overrides: SenderOverrides & { now?: () => Date } = {},
) =>
  Effect.gen(function* () {
    const now = overrides.now?.() ?? new Date();
    const snapshot = yield* persist(() =>
      getEmailSettingsSnapshot(environment),
    );
    const settings = snapshot.settings;
    if (settings === null || settings.revision !== input.expectedRevision) {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    const state = stateFromSnapshot(environment, snapshot);
    const testable = savedConfigurationTestable(state);
    if (!testable.ok) {
      return yield* Effect.fail(domainError(testable.code, testable.message));
    }

    const existing = yield* persist(() =>
      getOwnedNotificationTestAttempt(
        environment,
        input.requestId,
        input.actorUserId,
      ),
    );
    if (existing === null) {
      const foreign = yield* persist(() =>
        getNotificationTestAttempt(environment, input.requestId),
      );
      if (foreign !== null) {
        return yield* Effect.fail(
          domainError(
            'test_request_conflict',
            'This test request id is already in use. Start a new test.',
          ),
        );
      }

      yield* reserveTest(environment, settings, input, now);
    } else {
      if (testAttemptConflict(existing, state, input) !== null) {
        return yield* Effect.fail(
          domainError(
            'test_request_conflict',
            'This test request belongs to an earlier configuration. Start a new test.',
          ),
        );
      }

      if (!canReplayTest(existing, state, input, now)) {
        return finishStoredTest(existing);
      }
    }

    return yield* persist(() =>
      sendAndRecordTest(environment, state, input, overrides, now, existing),
    );
  });

// --- Delivery state machine --------------------------------------------------

export type ProcessNotificationOptions = SenderOverrides & {
  /**
   * Deterministic test seam: runs after the coherent snapshot and terminal
   * checks, immediately before the freeze boundary. Production never sets it.
   */
  beforeFreeze?: () => Promise<void>;
  /**
   * Deterministic test seam: replaces the durable acknowledgement transition
   * so an acknowledgement failure can be exercised without a database fault.
   */
  complete?: typeof completeNotificationAttempt;
  now?: () => Date;
  random?: () => number;
  randomToken?: () => string;
  timeBudgetMs?: number;
};

export type ProcessNotificationOutcome =
  | {
      attempt?: number;
      kind: 'accepted';
      messageId: null | string;
      outboxId: string;
    }
  | { attempt?: number; kind: 'disabled'; reasonCode: string }
  | { attempt?: number; kind: 'failed'; outboxId: string; reasonCode: string }
  | { attempt?: number; kind: 'idle' }
  | { attempt?: number; kind: 'misconfigured'; reasonCode: string }
  | { attempt?: number; kind: 'paused'; reasonCode: string }
  | { attempt?: number; kind: 'retry'; nextAttemptAt: Date; outboxId: string }
  | { attempt?: number; kind: 'skipped'; outboxId: string; reasonCode: string }
  | { attempt?: number; kind: 'unknown'; outboxId: string; reasonCode: string };

type Finish = (completion: NotificationCompletion) => Promise<boolean>;

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
  reasonCode === 'ambiguous' ||
  reasonCode === 'ambiguous_lease' ||
  reasonCode === 'idempotency_deadline_passed';

/**
 * True once any attempt left acceptance unresolved. Never cleared.
 */
const unresolvedAcceptance = (row: {
  reasonCode: null | string;
  uncertainAt: Date | null;
}): boolean => row.uncertainAt !== null || ambiguityReason(row.reasonCode);

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

const retryDeadlinePassed = (
  row: NotificationOutboxRecord,
  now: Date,
): boolean =>
  row.attemptCount > 0 &&
  row.provider === 'resend' &&
  row.idempotencyDeadline !== null &&
  now.getTime() >= row.idempotencyDeadline.getTime();

/**
 * Terminal rechecks that run after the claim: recipient eligibility, event
 * age, configuration pinning, retry deadline, and attempt exhaustion. Any
 * earlier unresolved acceptance outcome stays `unknown`; suppression stops
 * retries without claiming the message was never sent.
 */
const earlyCompletion = async (
  environment: Env,
  row: NotificationOutboxRecord,
  settings: EmailSettingsRecord,
  now: Date,
): Promise<EarlyCompletion | null> => {
  const unresolved = unresolvedAcceptance(row);
  const eligibility = await getNotificationEligibility(environment, row);
  const verdict = eligibilityVerdict(row, eligibility);
  if (verdict !== null) {
    if (unresolved) {
      const reasonCode = `ambiguous_${verdict.reasonCode}`;
      return {
        completion: {
          reasonCode,
          status: 'unknown',
          uncertain: true,
        },
        outcome: {
          attempt: row.attemptCount,
          kind: 'unknown',
          outboxId: row.id,
          reasonCode,
        },
      };
    }

    return {
      completion: { reasonCode: verdict.reasonCode, status: verdict.status },
      outcome: {
        attempt: row.attemptCount,
        kind: 'skipped',
        outboxId: row.id,
        reasonCode: verdict.reasonCode,
      },
    };
  }

  if (now.getTime() - row.createdAt.getTime() >= NOTIFICATION_EVENT_TTL_MS) {
    return {
      completion: unresolved
        ? {
            reasonCode: 'expired_ambiguous',
            status: 'unknown',
            uncertain: true,
          }
        : { reasonCode: 'expired', status: 'skipped' },
      outcome: {
        attempt: row.attemptCount,
        kind: unresolved ? 'unknown' : 'skipped',
        outboxId: row.id,
        reasonCode: unresolved ? 'expired_ambiguous' : 'expired',
      },
    };
  }

  if (
    row.attemptCount > 0 &&
    row.configRevision !== null &&
    row.configRevision !== settings.revision
  ) {
    return {
      completion: {
        reasonCode: 'config_changed',
        status: 'unknown',
        ...(unresolved ? { uncertain: true } : {}),
      },
      outcome: {
        attempt: row.attemptCount,
        kind: 'unknown',
        outboxId: row.id,
        reasonCode: 'config_changed',
      },
    };
  }

  if (retryDeadlinePassed(row, now)) {
    return {
      completion: {
        reasonCode: 'idempotency_deadline_passed',
        status: 'unknown',
        ...(unresolved ? { uncertain: true } : {}),
      },
      outcome: {
        attempt: row.attemptCount,
        kind: 'unknown',
        outboxId: row.id,
        reasonCode: 'idempotency_deadline_passed',
      },
    };
  }

  if (row.attemptCount >= NOTIFICATION_MAX_ATTEMPTS) {
    return {
      completion: unresolved
        ? {
            reasonCode: 'ambiguous_exhausted',
            status: 'unknown',
            uncertain: true,
          }
        : { reasonCode: 'retry_exhausted', status: 'failed' },
      outcome: {
        attempt: row.attemptCount,
        kind: unresolved ? 'unknown' : 'failed',
        outboxId: row.id,
        reasonCode: unresolved ? 'ambiguous_exhausted' : 'retry_exhausted',
      },
    };
  }

  return null;
};

type PreparedAttempt =
  | { attempt: number; kind: 'frozen_payload_invalid' }
  | { attempt: number; kind: 'provider_missing' }
  | {
      deliveryKey: string;
      envelope: EmailEnvelope;
      idempotencyDeadline: Date | null;
      kind: 'ready';
      payloadHash: string;
      provider: EmailProvider;
    };

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
    return { attempt: row.attemptCount, kind: 'provider_missing' };
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
      return { attempt: row.attemptCount, kind: 'frozen_payload_invalid' };
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
  const attempt = row.attemptCount + 1;
  if (result.kind === 'accepted') {
    const acknowledged = await finish({
      acceptedAt: now,
      providerMessageId: result.messageId ?? null,
      reasonCode: null,
      status: 'accepted',
    });
    if (acknowledged) {
      await recordNotificationDispatchSuccess(environment, now);
      return {
        attempt,
        kind: 'accepted',
        messageId: result.messageId ?? null,
        outboxId: row.id,
      };
    }

    // The provider accepted the message but the durable acceptance row was
    // not written. Report an unresolved outcome instead of claiming success.
    return {
      attempt,
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: 'ack_failed',
    };
  }

  if (result.kind === 'ambiguous') {
    const retryableResend =
      prepared.provider === 'resend' &&
      prepared.idempotencyDeadline !== null &&
      now.getTime() < prepared.idempotencyDeadline.getTime();
    if (retryableResend) {
      await finish({
        reasonCode: 'ambiguous',
        status: 'retry',
        uncertain: true,
      });
      return {
        attempt,
        kind: 'retry',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        outboxId: row.id,
      };
    }

    await finish({
      reasonCode: result.reason,
      status: 'unknown',
      uncertain: true,
    });
    return {
      attempt,
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: result.reason,
    };
  }

  // Definite rejection. Recipient/request failures end this one row; only an
  // evidenced persistent configuration failure pauses the revision.
  const nextAttempt = attempt;
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
    return { attempt, kind: 'retry', nextAttemptAt, outboxId: row.id };
  }

  if (unresolvedAcceptance(row)) {
    await finish({
      reasonCode: 'unresolved_after_rejection',
      status: 'unknown',
      uncertain: true,
    });
    return {
      attempt,
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: 'unresolved_after_rejection',
    };
  }

  const reasonCode = exhausted ? 'retry_exhausted' : result.reason;
  await finish({ reasonCode, status: 'failed' });
  if (CONFIGURATION_FAILURE_REASONS.has(result.reason)) {
    await recordEmailSettingsConfigError(environment, {
      now,
      reasonCode: result.reason,
      revision: settings.revision,
    });
  }

  return { attempt, kind: 'failed', outboxId: row.id, reasonCode };
};

/**
 * Re-checks the freshly persisted state after a failed freeze. Returning null
 * means no safe terminal outcome can be derived here; the row stays claimed
 * and lease recovery re-queues it, which is safer than guessing.
 */
const sendBoundaryRecheck = async (
  environment: Env,
  row: NotificationOutboxRecord,
  state: EmailSettingsState,
  now: Date,
): Promise<EarlyCompletion | null> => {
  const unresolved = unresolvedAcceptance(row);
  if (state.availability === 'disabled') {
    return {
      completion: { reasonCode: 'disabled', status: 'skipped' },
      outcome: {
        attempt: row.attemptCount,
        kind: 'skipped',
        outboxId: row.id,
        reasonCode: 'disabled',
      },
    };
  }

  if (state.availability !== 'configured') {
    const reasonCode = state.readinessReason ?? 'misconfigured';
    return {
      completion: {
        reasonCode,
        status: 'unknown',
        ...(unresolved ? { uncertain: true } : {}),
      },
      outcome: {
        attempt: row.attemptCount,
        kind: 'unknown',
        outboxId: row.id,
        reasonCode,
      },
    };
  }

  const settings = state.settings;
  if (settings === null) {
    return null;
  }

  return earlyCompletion(environment, row, settings, now);
};

const processNextNotificationInner = async (
  environment: Env,
  options: ProcessNotificationOptions = {},
): Promise<ProcessNotificationOutcome> => {
  const currentTime = (): Date => new Date(options.now?.() ?? Date.now());
  let now = currentTime();
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

  const complete = options.complete ?? completeNotificationAttempt;
  const finish: Finish = (completion) =>
    ackWithRetry(() =>
      complete(environment, {
        completion,
        leaseToken,
        outboxId: row.id,
        timestamp: currentTime(),
      }),
    );

  const early = await earlyCompletion(environment, row, settings, now);
  if (early !== null) {
    await finish(early.completion);
    return early.outcome;
  }

  const prepared = await prepareAttempt(row, settings, now);
  if (prepared.kind === 'provider_missing') {
    await finish({
      reasonCode: 'provider_unavailable',
      status: 'unknown',
      ...(unresolvedAcceptance(row) ? { uncertain: true } : {}),
    });
    return {
      attempt: prepared.attempt,
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: 'provider_unavailable',
    };
  }

  if (prepared.kind === 'frozen_payload_invalid') {
    await finish({ reasonCode: 'frozen_payload_invalid', status: 'failed' });
    return {
      attempt: prepared.attempt,
      kind: 'failed',
      outboxId: row.id,
      reasonCode: 'frozen_payload_invalid',
    };
  }

  await options.beforeFreeze?.();

  // The sender is built from the coherent snapshot before the freeze, so the
  // external call cannot adopt a credential saved after the boundary.
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
      attempt: row.attemptCount,
      kind: 'misconfigured',
      reasonCode,
    };
  }

  now = currentTime();
  if (retryDeadlinePassed(row, now)) {
    await finish({
      reasonCode: 'idempotency_deadline_passed',
      status: 'unknown',
      ...(unresolvedAcceptance(row) ? { uncertain: true } : {}),
    });
    return {
      attempt: row.attemptCount,
      kind: 'unknown',
      outboxId: row.id,
      reasonCode: 'idempotency_deadline_passed',
    };
  }

  const frozen = await freezeNotificationAttempt(environment, {
    configRevision: settings.revision,
    deliveryKey: prepared.deliveryKey,
    envelopeJson: serializeEnvelope(prepared.envelope),
    idempotencyDeadline: prepared.idempotencyDeadline,
    leadId: row.leadId,
    leaseMs: NOTIFICATION_LEASE_MS,
    leaseToken,
    outboxId: row.id,
    payloadHash: prepared.payloadHash,
    provider: prepared.provider,
    recipientUserId: row.recipientUserId,
    timestamp: now,
    writeToken: settings.writeToken,
  });
  if (!frozen) {
    const currentRow = await getNotificationOutboxRow(environment, row.id);
    if (
      currentRow === null ||
      currentRow.status !== 'claimed' ||
      currentRow.leaseToken !== leaseToken
    ) {
      return { attempt: row.attemptCount, kind: 'idle' };
    }

    const latestState = await loadEmailSettingsState(environment);
    const recheck = await sendBoundaryRecheck(
      environment,
      currentRow,
      latestState,
      currentTime(),
    );
    if (recheck !== null) {
      await finish(recheck.completion);
      return recheck.outcome;
    }

    return { attempt: row.attemptCount, kind: 'idle' };
  }

  const renewed = await renewNotificationLease(environment, {
    leaseMs: NOTIFICATION_LEASE_MS,
    leaseToken,
    outboxId: row.id,
    timestamp: now,
  });
  if (!renewed) {
    // The lease was lost or recovered; a successor owns the row now and this
    // invocation must not start an external call.
    return { attempt: row.attemptCount, kind: 'idle' };
  }

  let result: SendResult;
  try {
    result = await sender.send(prepared.envelope, {
      deliveryKey: prepared.deliveryKey,
    });
  } catch {
    result = {
      kind: 'ambiguous',
      provider: prepared.provider,
      reason: 'unexpected_error',
    };
  }

  return recordSendResult(
    environment,
    row,
    settings,
    prepared,
    now,
    result,
    finish,
    options,
  );
};

/**
 * Processes at most one due notification and emits one bounded structured
 * outcome line (opaque ids, outcome, attempt, allowlisted reason). The
 * external call is never part of the intake transaction and a stale lease
 * holder cannot overwrite its successor.
 */
export const processNextNotification = async (
  environment: Env,
  options: ProcessNotificationOptions = {},
): Promise<ProcessNotificationOutcome> => {
  const outcome = await processNextNotificationInner(environment, options);
  logNotificationDispatchOutcome(outcome);
  return outcome;
};

// --- Bounded scheduled dispatch ---------------------------------------------

export type NotificationDispatchResult = {
  outcomes: ProcessNotificationOutcome[];
  processed: number;
  stopped: 'idle' | 'limit' | 'time' | 'unavailable';
};

/**
 * One bounded scheduling unit: record the tick, recover a bounded number of
 * expired leases and stale events, clean up a bounded number of terminal
 * rows, then process at most `batchLimit` due notifications while leaving
 * time for acknowledgement. The default of one message per tick keeps CPU
 * headroom on Workers Free; the maintenance statements still run every tick,
 * including while email is disabled.
 */
export const runNotificationDispatch = async (
  environment: Env,
  options: ProcessNotificationOptions & {
    batchLimit?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<NotificationDispatchResult> => {
  const now = new Date(options.now?.() ?? Date.now());
  const startedAt = Date.now();
  const budget = options.timeBudgetMs ?? DISPATCH_TIME_BUDGET_MS;
  const limit = options.batchLimit ?? DISPATCH_BATCH_LIMIT;
  await recordNotificationDispatchTick(environment, now);
  await recoverExpiredNotificationLeases(
    environment,
    now,
    MAINTENANCE_BATCH_LIMIT,
  );
  await expireStaleNotificationIntents(
    environment,
    new Date(now.getTime() - NOTIFICATION_EVENT_TTL_MS),
    now,
    MAINTENANCE_BATCH_LIMIT,
  );
  await cleanupResolvedNotificationRows(
    environment,
    new Date(now.getTime() - NOTIFICATION_RETENTION_MS),
    MAINTENANCE_BATCH_LIMIT,
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
