/**
 * Installation email settings: readiness state, the redacted view, and the
 * compare-and-swap save command.
 *
 * The store service owns the distributed CAS mechanics; this module owns the
 * product rules (which fields are editable, credential operations, redacted
 * audit changes). Decryption/encryption goes through `CredentialCipher`, so
 * no plaintext key is ever cached or threaded through the view layer.
 */

import {
  Deployment,
  type DeploymentCapabilities,
} from '@/application/deployment';
import { testView } from '@/application/email-test-view';
import {
  DomainError,
  domainError,
  type PersistenceError,
} from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import {
  type AuditChange,
  type AuditWrite,
  type EmailSettingsView,
  type EncryptedCredential,
  type InstallationConfig,
  type InstallationEmailConfig,
  type NotificationAvailability,
} from '@/domain/schemas';
import {
  CredentialCipher,
  type CredentialCipherService,
} from '@/notifications/credential-cipher';
import { type EmailProvider } from '@/notifications/email';
import { Effect, Either } from 'effect';

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

const unavailableState = (
  capabilities: DeploymentCapabilities,
): EmailSettingsState => ({
  availability: 'misconfigured',
  credential: null,
  hasCloudflareBinding: capabilities.hasCloudflareEmailBinding,
  hasEncryptionKey: capabilities.hasCredentialEncryptionKey,
  hasResendCredential: false,
  provider: null,
  readinessReason: 'config_invalid',
  settings: null,
});

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
export const stateFromDocument = (
  capabilities: DeploymentCapabilities,
  document: InstallationConfig,
): EmailSettingsState => {
  const email = document.email;
  const hasCloudflareBinding = capabilities.hasCloudflareEmailBinding;
  const hasEncryptionKey = capabilities.hasCredentialEncryptionKey;

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
 * Lenient state for self-service preference reads and the email subscriber:
 * a corrupt document becomes a redacted misconfigured state instead of
 * failing those paths.
 */
export const loadEmailSettingsState: Effect.Effect<
  EmailSettingsState,
  never,
  Deployment | InstallationConfigStore
> = Effect.gen(function* () {
  const store = yield* InstallationConfigStore;
  const capabilities = yield* Deployment;
  const outcome = yield* Effect.either(store.read);
  return Either.isRight(outcome)
    ? stateFromDocument(capabilities, outcome.right.document)
    : unavailableState(capabilities);
});

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

const emailSettingsView = (
  capabilities: DeploymentCapabilities,
  canonicalOriginFallback: string,
  document: InstallationConfig,
): EmailSettingsView => {
  const state = stateFromDocument(capabilities, document);
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

const configUnavailable = () =>
  domainError(
    'config_unavailable',
    'The installation configuration is unreadable. Restore it from a backup or ask an operator to repair it.',
  );

export const getEmailSettingsViewCommand = (
  canonicalOriginFallback: string,
): Effect.Effect<
  EmailSettingsView,
  DomainError | PersistenceError,
  Deployment | InstallationConfigStore
> =>
  Effect.gen(function* () {
    const store = yield* InstallationConfigStore;
    const capabilities = yield* Deployment;
    const row = yield* store.read.pipe(
      Effect.catchTag('InstallationConfigUnavailable', () =>
        Effect.fail(configUnavailable()),
      ),
    );
    return emailSettingsView(
      capabilities,
      canonicalOriginFallback,
      row.document,
    );
  });

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

const replaceCredentialEnvelope = (
  cipher: CredentialCipherService,
  input: UpdateEmailSettingsInput,
): Effect.Effect<EncryptedCredential, DomainError> =>
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

    return yield* cipher
      .encrypt(value)
      .pipe(
        Effect.mapError((error) =>
          domainError(
            error.code === 'invalid_key'
              ? 'encryption_key_invalid'
              : error.code === 'missing_key'
                ? 'encryption_key_missing'
                : 'encryption_failed',
            error.code === 'missing_key'
              ? 'Saving a Resend key requires the EMAIL_SETTINGS_ENCRYPTION_KEY deployment secret. Ask the installation owner to configure it.'
              : 'The email credential could not be encrypted with the configured key.',
          ),
        ),
      );
  });

export const updateEmailSettingsCommand = (input: UpdateEmailSettingsInput) =>
  Effect.gen(function* () {
    const store = yield* InstallationConfigStore;
    const capabilities = yield* Deployment;
    const cipher = yield* CredentialCipher;

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
        envelope: yield* replaceCredentialEnvelope(cipher, input),
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

    const transaction = yield* store
      .transact(input.actorUserId, (row) =>
        Effect.gen(function* () {
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
              changes: settingsAuditChanges(
                row.document.email,
                nextEmail,
                change,
              ),
              resourceId: null,
              resourceType: 'installation.email',
            },
          ];
          return { audit, document: nextDocument, result: undefined };
        }),
      )
      .pipe(
        Effect.catchTag('InstallationConfigConflict', () =>
          Effect.fail(
            domainError(
              'revision_conflict',
              'Email settings changed in another session. Reload and try again.',
            ),
          ),
        ),
        Effect.catchTag('InstallationConfigUnavailable', () =>
          Effect.fail(configUnavailable()),
        ),
      );

    return emailSettingsView(
      capabilities,
      input.canonicalOrigin,
      transaction.document,
    );
  });
