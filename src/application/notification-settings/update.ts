import { configUnavailable, emailSettingsView } from './state';
import { Deployment } from '@/application/deployment';
import { DomainError, domainError } from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import {
  type AuditChange,
  type AuditWrite,
  type EncryptedCredential,
  type InstallationConfig,
  type InstallationEmailConfig,
} from '@/domain/schemas';
import {
  CredentialCipher,
  type CredentialCipherService,
} from '@/notifications/credential-cipher';
import { Effect } from 'effect';

export type UpdateEmailSettingsInput = {
  actorUserId: string;
  canonicalOrigin: string;
  credential: {
    operation: 'keep' | 'remove' | 'replace';
    value?: string;
  };
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

  // Removing the credential that backs the selected provider switches it off
  // instead of leaving an unroutable configuration selected. Sender values are
  // retained so the method can be restored later.
  if (change.kind === 'remove' && input.provider === 'resend') {
    return {
      canonicalOrigin: input.canonicalOrigin,
      credential,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      provider: 'disabled',
    };
  }

  return {
    canonicalOrigin: input.canonicalOrigin,
    credential,
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
