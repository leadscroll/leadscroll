/**
 * Application commands for new-lead email notifications.
 *
 * Business rules live here per the repository boundary: the installation-wide
 * configuration document, credential encryption/decryption, the optional
 * administrator test send, and self-service preferences. Notification
 * delivery itself is a best-effort event subscriber
 * (src/notifications/lead-created-subscriber.ts); there is no outbox,
 * scheduler, retry engine, or delivery history.
 *
 * The configuration document is validated on every read and before every
 * write. User-visible settings changes use the document `revision`; internal
 * test-state updates use the table `write_version` through ordinary
 * compare-and-swap retries, so a test completion cannot invalidate a settings
 * draft or overwrite a concurrent key change.
 */

import { DomainError, PersistenceError } from '@/application/errors';
import {
  type Env,
  getNotificationPreference,
  InstallationConfigDecodeError,
  type InstallationConfigRow,
  readInstallationConfig,
  upsertNotificationPreference,
  writeInstallationConfig,
} from '@/db/repository';
import {
  type AuditChange,
  type AuditWrite,
  EMAIL_TEST_MIN_INTERVAL_MS,
  EMAIL_TEST_ROLLING_LIMIT,
  EMAIL_TEST_WINDOW_MS,
  type EmailSettingsView,
  type EmailTestState,
  type EmailTestView,
  type EncryptedCredential,
  type InstallationConfig,
  type InstallationEmailConfig,
  type NotificationAvailability,
  type NotificationPreferenceView,
} from '@/domain/schemas';
import { DEFAULT_WORKSPACE_ID } from '@/domain/workspace';
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

/**
 * Bounded ordinary CAS retries for read/validate/mutate/write.
 */
const MAX_CONFIG_CAS_ATTEMPTS = 3;

// --- Settings availability ---------------------------------------------------

export type EmailSettingsState = {
  availability: NotificationAvailability;
  credential: EncryptedCredential | null;
  hasCloudflareBinding: boolean;
  hasEncryptionKey: boolean;
  hasResendCredential: boolean;
  provider: EmailProvider | null;
  readinessReason: null | string;
  settings: InstallationEmailConfig | null;
};

const hasConfiguredEncryptionKey = (environment: Env): boolean =>
  (environment.EMAIL_SETTINGS_ENCRYPTION_KEY?.trim() ?? '') !== '';

const configuredReadiness = (
  state: {
    credential: EncryptedCredential | null;
    hasCloudflareBinding: boolean;
    hasEncryptionKey: boolean;
  },
  email: InstallationEmailConfig,
): null | string => {
  if (email.fromEmail === null || email.fromEmail.length === 0) {
    return 'from_email_missing';
  }

  if (email.provider === 'cloudflare') {
    return state.hasCloudflareBinding ? null : 'cloudflare_binding_missing';
  }

  if (state.credential === null) {
    return 'resend_api_key_missing';
  }

  return state.hasEncryptionKey ? null : 'encryption_key_missing';
};

/**
 * Derives local readiness from one coherent configuration document.
 * `configured` means the saved selection has the resources it needs as far as
 * this deployment can tell; it is never evidence of remote entitlement or an
 * accepted test message.
 */
const stateFromDocument = (
  environment: Env,
  document: InstallationConfig,
): EmailSettingsState => {
  const email = document.email;
  const hasCloudflareBinding = environment.EMAIL !== undefined;
  const hasEncryptionKey = hasConfiguredEncryptionKey(environment);

  if (email.provider === 'disabled') {
    return {
      availability: 'disabled',
      credential: null,
      hasCloudflareBinding,
      hasEncryptionKey,
      hasResendCredential: false,
      provider: null,
      readinessReason: null,
      settings: email,
    };
  }

  const credential = email.provider === 'resend' ? email.credential : null;
  const readinessReason = configuredReadiness(
    { credential, hasCloudflareBinding, hasEncryptionKey },
    email,
  );

  let availability: NotificationAvailability;
  if (!email.enabled) {
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
    provider: email.provider,
    readinessReason,
    settings: email,
  };
};

/**
 * Lenient state for self-service preference reads and the email subscriber.
 * A corrupt document is reported as misconfigured with a redacted reason so
 * those paths fail closed instead of throwing; settings routes use the strict
 * read below and refuse to display or overwrite corrupt data.
 */
export const loadEmailSettingsState = async (
  environment: Env,
): Promise<EmailSettingsState> => {
  try {
    const row = await readInstallationConfig(environment);
    return stateFromDocument(environment, row.document);
  } catch (error) {
    if (error instanceof InstallationConfigDecodeError) {
      const hasCloudflareBinding = environment.EMAIL !== undefined;
      return {
        availability: 'misconfigured',
        credential: null,
        hasCloudflareBinding,
        hasEncryptionKey: hasConfiguredEncryptionKey(environment),
        hasResendCredential: false,
        provider: null,
        readinessReason: 'config_invalid',
        settings: null,
      };
    }

    throw error;
  }
};

export type SavedConfigurationTest =
  { code: string; message: string; ok: false } | { ok: true };

/**
 * Whether the *saved* provider configuration can produce a test message.
 * The installation enable switch being off does not block an explicit test:
 * testing is how setup is confirmed without turning live alerts on.
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

  const credential = state.credential;
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
      workspaceId: DEFAULT_WORKSPACE_ID,
    },
  );
  return createResendEmailSender(
    apiKey,
    overrides.fetchImplementation ?? fetch,
  );
};

// --- Strict configuration reads ----------------------------------------------

/**
 * Reads the configuration and maps an unreadable document to a redacted
 * domain error. Settings routes use this so corrupt data is never echoed,
 * silently reset, or overwritten by a default-revision save.
 */
const readConfigOrFail = (environment: Env) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.either(
      persist(() => readInstallationConfig(environment)),
    );
    if (Either.isLeft(outcome)) {
      if (outcome.left.cause instanceof InstallationConfigDecodeError) {
        return yield* Effect.fail(
          domainError(
            'config_unavailable',
            'The installation configuration is unreadable. Restore it from a backup or ask an operator to repair it.',
          ),
        );
      }

      return yield* Effect.fail(outcome.left);
    }

    return outcome.right;
  });

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

const testViewForState = (last: EmailTestState): EmailTestView => ({
  at: new Date(last.at).toISOString(),
  outcome: last.outcome,
  providerMessageId: last.providerMessageId,
  reasonCode: last.reasonCode,
  revision: last.configRevision,
});

const testView = (last: EmailTestState | null): EmailTestView | null =>
  last === null ? null : testViewForState(last);

const emailSettingsView = (
  environment: Env,
  canonicalOriginFallback: string,
  document: InstallationConfig,
): EmailSettingsView => {
  const state = stateFromDocument(environment, document);
  return {
    canonicalOrigin: document.email.canonicalOrigin ?? canonicalOriginFallback,
    enabled: document.email.enabled,
    environment: {
      hasCloudflareBinding: state.hasCloudflareBinding,
      hasEncryptionKey: state.hasEncryptionKey,
    },
    fromEmail: document.email.fromEmail,
    fromName: document.email.fromName,
    hasApiKey:
      document.email.provider === 'resend'
        ? document.email.credential !== null
        : false,
    provider: document.email.provider,
    readiness: {
      availability: state.availability,
      reasonCode: state.readinessReason,
    },
    revision: document.revision,
    test: testView(document.emailTest.last),
  };
};

export const getEmailSettingsView = async (
  environment: Env,
  canonicalOriginFallback: string,
): Promise<EmailSettingsView> => {
  const row = await readInstallationConfig(environment);
  return emailSettingsView(environment, canonicalOriginFallback, row.document);
};

export const getEmailSettingsViewCommand = (
  environment: Env,
  canonicalOriginFallback: string,
) =>
  Effect.gen(function* () {
    const row = yield* readConfigOrFail(environment);
    return emailSettingsView(
      environment,
      canonicalOriginFallback,
      row.document,
    );
  });

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
          workspaceId: DEFAULT_WORKSPACE_ID,
        }),
    });
  });

type CredentialChange =
  | { envelope: EncryptedCredential; kind: 'replace' }
  | { kind: 'keep' }
  | { kind: 'remove' };

const nextEmailConfig = (
  current: InstallationEmailConfig,
  input: UpdateEmailSettingsInput,
  change: CredentialChange,
): InstallationEmailConfig => {
  let credential = current.credential;
  if (change.kind === 'replace') {
    credential = change.envelope;
  } else if (change.kind === 'remove') {
    credential = null;
  }

  // Removing the credential that backs the selected provider disables that
  // provider instead of leaving an unroutable configuration enabled.
  if (change.kind === 'remove' && input.provider === 'resend') {
    return {
      canonicalOrigin: input.canonicalOrigin,
      credential,
      enabled: false,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      provider: 'disabled',
    };
  }

  return {
    canonicalOrigin: input.canonicalOrigin,
    credential,
    enabled: input.enabled,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    provider: input.provider,
  };
};

/**
 * Redacted audit changes for one settings save. Credential changes are
 * recorded as safe markers (`stored`, `replaced`, `removed`) and never as
 * ciphertext, nonces, or plaintext.
 */
const settingsAuditChanges = (
  current: InstallationEmailConfig,
  next: InstallationEmailConfig,
  change: CredentialChange,
): AuditChange[] => {
  const changes: AuditChange[] = [];
  const push = (
    field: string,
    before: AuditChange['before'],
    after: AuditChange['after'],
  ) => {
    if (before !== after) {
      changes.push({ after, before, field });
    }
  };

  push('email.provider', current.provider, next.provider);
  push('email.enabled', current.enabled, next.enabled);
  push('email.fromEmail', current.fromEmail, next.fromEmail);
  push('email.fromName', current.fromName, next.fromName);
  push('email.canonicalOrigin', current.canonicalOrigin, next.canonicalOrigin);

  const credentialBefore = current.credential === null ? null : 'stored';
  let credentialAfter = credentialBefore;
  if (change.kind === 'replace') {
    credentialAfter = current.credential === null ? 'stored' : 'replaced';
  } else if (change.kind === 'remove') {
    credentialAfter = current.credential === null ? null : 'removed';
  }

  push('email.credential', credentialBefore, credentialAfter);
  return changes;
};

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

    let change: CredentialChange = { kind: 'keep' };
    if (input.credential.operation === 'replace') {
      change = {
        envelope: yield* replaceCredentialEnvelope(environment, input),
        kind: 'replace',
      };
    } else if (input.credential.operation === 'remove') {
      change = { kind: 'remove' };
    }

    const normalizedInput: UpdateEmailSettingsInput = {
      ...input,
      fromEmail,
      fromName,
    };

    for (let attempt = 0; attempt < MAX_CONFIG_CAS_ATTEMPTS; attempt += 1) {
      const row: InstallationConfigRow = yield* readConfigOrFail(environment);
      if (row.document.revision !== input.expectedRevision) {
        return yield* Effect.fail(
          domainError(
            'revision_conflict',
            'Email settings changed in another session. Reload and try again.',
          ),
        );
      }

      const nextEmail = nextEmailConfig(
        row.document.email,
        normalizedInput,
        change,
      );
      const nextDocument: InstallationConfig = {
        ...row.document,
        email: nextEmail,
        revision: row.document.revision + 1,
      };
      const audit: AuditWrite[] = [
        {
          action: 'email.settings_updated',
          changes: settingsAuditChanges(row.document.email, nextEmail, change),
          resourceId: null,
          resourceType: 'installation.email',
        },
      ];
      const wrote = yield* persist(() =>
        writeInstallationConfig(environment, {
          actorUserId: input.actorUserId,
          audit,
          document: nextDocument,
          expectedWriteVersion: row.writeVersion,
          now: new Date(),
        }),
      );
      if (wrote) {
        return yield* persist(() =>
          getEmailSettingsView(environment, input.canonicalOrigin),
        );
      }
    }

    return yield* Effect.fail(
      domainError(
        'revision_conflict',
        'Email settings changed in another session. Reload and try again.',
      ),
    );
  });

// --- Administrator test email ------------------------------------------------

export type SendTestEmailInput = {
  actorEmail: string;
  actorUserId: string;
  canonicalOrigin: string;
  expectedRevision: number;
  requestId: string;
};

type TestReservation =
  | { document: InstallationConfig; kind: 'reserved' }
  | { kind: 'daily_limited' }
  | { kind: 'duplicate'; last: EmailTestState }
  | { kind: 'foreign' }
  | { kind: 'rate_limited' }
  | { kind: 'revision_conflict' };

/**
 * Reserves one test attempt inside the configuration document before any
 * outbound call. The rolling window is pruned here, the one-per-minute and
 * five-per-24-hours limits are re-evaluated after every lost CAS race, and
 * only the most recent request id is retained for own-actor duplicate
 * protection.
 */
const reserveTestAttempt = async (
  environment: Env,
  input: {
    actorUserId: string;
    expectedRevision: number;
    now: Date;
    requestId: string;
  },
): Promise<TestReservation> => {
  for (let attempt = 0; attempt < MAX_CONFIG_CAS_ATTEMPTS; attempt += 1) {
    const row = await readInstallationConfig(environment);
    const { document } = row;
    if (document.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict' };
    }

    const last = document.emailTest.last;
    if (last !== null && last.requestId === input.requestId) {
      return last.actorUserId === input.actorUserId
        ? { kind: 'duplicate', last }
        : { kind: 'foreign' };
    }

    const nowMs = input.now.getTime();
    const recent = document.emailTest.recent.filter(
      (entry) => entry.at > nowMs - EMAIL_TEST_WINDOW_MS,
    );
    if (recent.some((entry) => entry.at > nowMs - EMAIL_TEST_MIN_INTERVAL_MS)) {
      return { kind: 'rate_limited' };
    }

    if (recent.length >= EMAIL_TEST_ROLLING_LIMIT) {
      return { kind: 'daily_limited' };
    }

    const provider =
      document.email.provider === 'disabled' ? null : document.email.provider;
    const reserved: InstallationConfig = {
      ...document,
      emailTest: {
        last: {
          actorUserId: input.actorUserId,
          at: nowMs,
          configRevision: document.revision,
          outcome: 'sending',
          provider,
          providerMessageId: null,
          reasonCode: null,
          requestId: input.requestId,
        },
        recent: [...recent, { actorUserId: input.actorUserId, at: nowMs }],
      },
    };
    const wrote = await writeInstallationConfig(environment, {
      actorUserId: input.actorUserId,
      document: reserved,
      expectedWriteVersion: row.writeVersion,
      now: input.now,
    });
    if (wrote) {
      return { document: reserved, kind: 'reserved' };
    }
  }

  throw new Error('The test reservation could not be committed.');
};

type TestCompletion = {
  providerMessageId?: null | string;
  reasonCode: null | string;
  status: 'accepted' | 'ambiguous' | 'configuration_error' | 'rejected';
};

/**
 * Reconciles only the reserved request id. A concurrent reservation or
 * settings save is never overwritten: the latest document is re-read and only
 * `emailTest.last` for our exact id is replaced. The outcome audit row is
 * written in the same atomic batch as the reconciliation, and the
 * reservation itself is not audited.
 */
const reconcileTestOutcome = async (
  environment: Env,
  input: {
    actorUserId: string;
    completion: TestCompletion;
    now: Date;
    requestId: string;
  },
): Promise<EmailTestState | null> => {
  for (let attempt = 0; attempt < MAX_CONFIG_CAS_ATTEMPTS; attempt += 1) {
    const row = await readInstallationConfig(environment);
    const last = row.document.emailTest.last;
    if (
      last === null ||
      last.requestId !== input.requestId ||
      last.actorUserId !== input.actorUserId
    ) {
      return last;
    }

    const nextLast: EmailTestState = {
      ...last,
      outcome: input.completion.status,
      providerMessageId: input.completion.providerMessageId ?? null,
      reasonCode: input.completion.reasonCode,
    };
    const document: InstallationConfig = {
      ...row.document,
      emailTest: { ...row.document.emailTest, last: nextLast },
    };
    const audit: AuditWrite[] = [
      {
        action: 'email.test_sent',
        changes: [
          { after: nextLast.outcome, before: 'sending', field: 'test.outcome' },
          {
            after: nextLast.provider,
            before: last.provider,
            field: 'test.provider',
          },
          {
            after: nextLast.reasonCode,
            before: last.reasonCode,
            field: 'test.reason',
          },
        ],
        resourceId: null,
        resourceType: 'installation.email_test',
      },
    ];
    const wrote = await writeInstallationConfig(environment, {
      actorUserId: input.actorUserId,
      audit,
      document,
      expectedWriteVersion: row.writeVersion,
      now: input.now,
    });
    if (wrote) {
      return nextLast;
    }
  }

  return null;
};

/**
 * Reads the caller's own stored attempt from the current document.
 */
const readOwnedTest = async (
  environment: Env,
  input: SendTestEmailInput,
): Promise<EmailTestView | null> => {
  const row = await readInstallationConfig(environment);
  const last = row.document.emailTest.last;
  if (
    last === null ||
    last.requestId !== input.requestId ||
    last.actorUserId !== input.actorUserId
  ) {
    return null;
  }

  return testViewForState(last);
};

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
  settings: InstallationEmailConfig,
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

/**
 * Sends one explicit administrator test to the caller's own account email
 * using the saved configuration. One attempt per request id: concurrent
 * double-clicks collide on the reserved id, and there is no automatic retry
 * or replay. Accepted, rejected, and unknown outcomes are reported honestly.
 * Test-state writes never change the user-visible settings revision.
 */
export const sendTestEmailCommand = (
  environment: Env,
  input: SendTestEmailInput,
  overrides: SenderOverrides & { now?: () => Date } = {},
) =>
  Effect.gen(function* () {
    const now = overrides.now?.() ?? new Date();
    const row = yield* readConfigOrFail(environment);
    const state = stateFromDocument(environment, row.document);
    if (row.document.revision !== input.expectedRevision) {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    const testable = savedConfigurationTestable(state);
    if (!testable.ok) {
      return yield* Effect.fail(domainError(testable.code, testable.message));
    }

    if (state.provider === null) {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    const reservation = yield* persist(() =>
      reserveTestAttempt(environment, {
        actorUserId: input.actorUserId,
        expectedRevision: input.expectedRevision,
        now,
        requestId: input.requestId,
      }),
    );
    if (reservation.kind === 'revision_conflict') {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    if (reservation.kind === 'foreign') {
      return yield* Effect.fail(
        domainError(
          'test_request_conflict',
          'This test request id is already in use. Start a new test.',
        ),
      );
    }

    if (reservation.kind === 'rate_limited') {
      return yield* Effect.fail(
        domainError(
          'test_rate_limited',
          'A test email was sent within the last minute. Try again shortly.',
          { retryAfterSeconds: 60 },
        ),
      );
    }

    if (reservation.kind === 'daily_limited') {
      return yield* Effect.fail(
        domainError(
          'test_daily_limited',
          'The daily limit of five test emails has been reached.',
          { retryAfterSeconds: 86_400 },
        ),
      );
    }

    if (reservation.kind === 'duplicate') {
      // Idempotent response: only the owner may see the stored attempt.
      return testViewForState(reservation.last);
    }

    // Use the exact document the reservation committed, so a concurrent
    // settings save after the reservation cannot retarget this send.
    const reservedState = stateFromDocument(environment, reservation.document);
    const reservedSettings = reservedState.settings;
    if (reservedSettings === null || reservedState.provider === null) {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    const senderEither = yield* Effect.either(
      persist(() =>
        createSenderFromState(environment, reservedState, overrides),
      ),
    );
    let completion: TestCompletion;
    if (Either.isLeft(senderEither)) {
      completion = {
        reasonCode: senderFailureReason(senderEither.left.cause),
        status: 'configuration_error',
      };
    } else {
      const sender = senderEither.right;
      const resultEither = yield* Effect.either(
        persist(() =>
          sender.send(buildTestEnvelope(reservedSettings, input), {
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
      const mapped = completionForTestResult(result);
      completion = {
        providerMessageId:
          result.kind === 'accepted' ? (result.messageId ?? null) : null,
        reasonCode: mapped.reasonCode,
        status: mapped.status,
      };
    }

    const last = yield* persist(() =>
      reconcileTestOutcome(environment, {
        actorUserId: input.actorUserId,
        completion,
        now,
        requestId: input.requestId,
      }),
    );
    if (last !== null) {
      return testViewForState(last);
    }

    return yield* readOwnedTestOrFail(environment, input);
  });
