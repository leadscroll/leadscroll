import {
  Deployment,
  type DeploymentCapabilities,
} from '@/application/deployment';
import { testView } from '@/application/email-test-view';
import {
  type DomainError,
  domainError,
  type PersistenceError,
} from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import {
  type EmailSettingsView,
  type EncryptedCredential,
  type InstallationConfig,
  type InstallationEmailConfig,
  type NotificationAvailability,
} from '@/domain/schemas';
import { type EmailProvider } from '@/notifications/email';
import { Effect, Result } from 'effect';

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

  const availability: NotificationAvailability =
    readinessReason === null ? 'configured' : 'misconfigured';

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
  const outcome = yield* Effect.result(store.read);
  return Result.isSuccess(outcome)
    ? stateFromDocument(capabilities, outcome.success.document)
    : unavailableState(capabilities);
});

export type SavedConfigurationTest =
  { code: string; message: string; ok: false } | { ok: true };

/**
 * Whether the *saved* sending method can produce a test message. `Off` cannot:
 * there is no configuration to test until a method is chosen.
 */
export const savedConfigurationTestable = (
  state: EmailSettingsState,
): SavedConfigurationTest => {
  const settings = state.settings;
  if (settings === null || settings.provider === 'disabled') {
    return {
      code: 'email_disabled',
      message: 'Choose a sending method before sending a test.',
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

export const emailSettingsView = (
  capabilities: DeploymentCapabilities,
  canonicalOriginFallback: string,
  document: InstallationConfig,
): EmailSettingsView => {
  const state = stateFromDocument(capabilities, document);
  return {
    canonicalOrigin: document.email.canonicalOrigin ?? canonicalOriginFallback,
    environment: {
      hasCloudflareBinding: state.hasCloudflareBinding,
      hasEncryptionKey: state.hasEncryptionKey,
    },
    fromEmail: document.email.fromEmail,
    fromName: document.email.fromName,
    // Credential presence is independent of the selected method: a stored
    // Resend key is retained when switching away so switching back does not
    // require re-entering it.
    hasApiKey: document.email.credential !== null,
    provider: document.email.provider,
    readiness: {
      availability: state.availability,
      reasonCode: state.readinessReason,
    },
    revision: document.revision,
    test: testView(document.emailTest.last),
  };
};

export const configUnavailable = () =>
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
