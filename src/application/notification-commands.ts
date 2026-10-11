/**
 * Application commands for new-lead email notifications.
 *
 * Business rules live here per the repository boundary: installation email
 * settings, credential decryption, the optional administrator test send, and
 * self-service preferences. Notification delivery itself is a best-effort
 * event subscriber (src/notifications/lead-created-subscriber.ts); there is no
 * outbox, scheduler, retry engine, or delivery history.
 */

import { DomainError, PersistenceError } from '@/application/errors';
import {
  completeNotificationTestAttempt,
  type EmailCredentialRecord,
  type EmailSettingsRecord,
  type EmailSettingsSnapshot,
  type Env,
  getEmailCredential,
  getEmailSettingsSnapshot,
  getLatestNotificationTestAttempt,
  getNotificationPreference,
  getNotificationTestAttempt,
  getOwnedNotificationTestAttempt,
  type NotificationTestAttemptRecord,
  recordEmailSettingsAudit,
  reserveNotificationTestAttempt,
  saveEmailSettings,
  upsertNotificationPreference,
} from '@/db/repository';
import {
  type EmailSettingsView,
  type EmailTestView,
  type NotificationPreferenceView,
} from '@/domain/schemas';
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from '@/notifications/credential-crypto';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type EmailEnvelope,
  type EmailProvider,
  type EmailSender,
  type SendResult,
  testDeliveryKeyFor,
} from '@/notifications/email';
import { createCloudflareEmailSender } from '@/notifications/providers/cloudflare';
import {
  createResendEmailSender,
  type FetchLike,
} from '@/notifications/providers/resend';
import { renderTestEmail } from '@/notifications/templates';
import { Effect, Either } from 'effect';

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
  provider: EmailProvider | null;
  readinessReason: null | string;
  settings: EmailSettingsRecord | null;
};

export type NotificationAvailability =
  'configured' | 'disabled' | 'misconfigured';

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
      provider: null,
      readinessReason: null,
      settings,
    };
  }

  const selectedCredential = settings.provider === 'resend' ? credential : null;
  const readinessReason = configuredReadiness(
    { credential: selectedCredential, hasCloudflareBinding, hasEncryptionKey },
    settings,
  );

  let availability: NotificationAvailability;
  if (!settings.enabled) {
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
    provider: settings.provider,
    readinessReason,
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
 * The installation enable switch being off does not block an explicit test:
 * testing is how an administrator confirms setup without turning live alerts
 * on.
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
 * Maps sender-construction failures to an allowlisted reason code.
 */
export const senderFailureReason = (error: unknown): string => {
  if (error instanceof CredentialCryptoError) {
    return error.code === 'missing_key'
      ? 'resend_api_key_missing'
      : 'decrypt_failed';
  }

  return 'provider_unavailable';
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

// --- Self-service preference -------------------------------------------------

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

// --- Administrator settings view ---------------------------------------------

const testViewForAttempt = (
  attempt: NotificationTestAttemptRecord,
): EmailTestView => ({
  at: (attempt.completedAt ?? attempt.createdAt).toISOString(),
  outcome: attempt.status,
  providerMessageId: attempt.providerMessageId,
  reasonCode: attempt.reasonCode,
  revision: attempt.configRevision,
});

const testView = (
  attempt: NotificationTestAttemptRecord | null,
): EmailTestView | null =>
  attempt === null ? null : testViewForAttempt(attempt);

export const getEmailSettingsView = async (
  environment: Env,
  canonicalOriginFallback: string,
): Promise<EmailSettingsView> => {
  const [latestTest, state] = await Promise.all([
    getLatestNotificationTestAttempt(environment),
    loadEmailSettingsState(environment),
  ]);
  const settings = state.settings;

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

const completionForTestResult = (
  result: SendResult,
): {
  reasonCode: null | string;
  status: 'accepted' | 'ambiguous' | 'rejected';
} => {
  if (result.kind === 'accepted') {
    return { reasonCode: null, status: 'accepted' };
  }

  if (result.kind === 'ambiguous') {
    return { reasonCode: result.reason, status: 'ambiguous' };
  }

  return { reasonCode: result.reason, status: 'rejected' };
};

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

const recordTestCompletion = (
  environment: Env,
  input: SendTestEmailInput,
  revision: number,
  now: Date,
  completion: {
    providerMessageId?: null | string;
    reasonCode: null | string;
    status: 'accepted' | 'ambiguous' | 'configuration_error' | 'rejected';
  },
) =>
  persist(async () => {
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
  });

const readOwnedTest = async (
  environment: Env,
  input: SendTestEmailInput,
): Promise<EmailTestView | null> => {
  const current = await getOwnedNotificationTestAttempt(
    environment,
    input.requestId,
    input.actorUserId,
  );
  return current === null ? null : testViewForAttempt(current);
};

/**
 * Reads the caller's own stored attempt or fails with the same conflict code
 * used for a foreign request id. This closes the duplicate-reservation race:
 * a concurrent winner's row is never returned to a different actor.
 */
const readOwnedTestOrFail = (environment: Env, input: SendTestEmailInput) =>
  Effect.gen(function* () {
    const view = yield* persist(() => readOwnedTest(environment, input));
    if (view === null) {
      return yield* Effect.fail(
        domainError(
          'test_request_conflict',
          'This test request belongs to another account. Start a new test.',
        ),
      );
    }

    return view;
  });

/**
 * Sends one explicit administrator test to the caller's own account email
 * using the saved configuration. One attempt per request id: concurrent
 * double-clicks collide on the durable reservation, and there is no automatic
 * retry or frozen-payload replay. Accepted, rejected, and ambiguous outcomes
 * are reported honestly; a rejected configuration is not persisted as a
 * delivery pause.
 */
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

    if (state.provider === null) {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    const provider = state.provider;

    const existing = yield* persist(() =>
      getNotificationTestAttempt(environment, input.requestId),
    );
    if (existing !== null) {
      if (existing.userId !== input.actorUserId) {
        return yield* Effect.fail(
          domainError(
            'test_request_conflict',
            'This test request id is already in use. Start a new test.',
          ),
        );
      }

      // Idempotent response: the same request id returns the stored attempt
      // instead of sending a second message.
      return testViewForAttempt(existing);
    }

    const reservation = yield* persist(() =>
      reserveNotificationTestAttempt(environment, {
        configRevision: settings.revision,
        now,
        provider,
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

    if (reservation === 'duplicate') {
      // A concurrent request with the same id won the reservation. Only the
      // owner may see the stored result; another actor gets a conflict.
      return yield* readOwnedTestOrFail(environment, input);
    }

    const senderEither = yield* Effect.either(
      persist(() => createSenderFromState(environment, state, overrides)),
    );
    if (Either.isLeft(senderEither)) {
      const reasonCode = senderFailureReason(senderEither.left.cause);
      yield* recordTestCompletion(environment, input, settings.revision, now, {
        reasonCode,
        status: 'configuration_error',
      });
      return yield* readOwnedTestOrFail(environment, input);
    }

    const sender = senderEither.right;
    const resultEither = yield* Effect.either(
      persist(() =>
        sender.send(buildTestEnvelope(settings, input), {
          deliveryKey: testDeliveryKeyFor(input.requestId),
          timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        }),
      ),
    );
    const result: SendResult = Either.isLeft(resultEither)
      ? {
          kind: 'ambiguous',
          provider: sender.provider,
          reason: 'unexpected_error',
        }
      : resultEither.right;

    const completion = completionForTestResult(result);
    yield* recordTestCompletion(environment, input, settings.revision, now, {
      providerMessageId:
        result.kind === 'accepted' ? (result.messageId ?? null) : null,
      reasonCode: completion.reasonCode,
      status: completion.status,
    });
    return yield* readOwnedTestOrFail(environment, input);
  });
