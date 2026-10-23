import { EmailSchema } from './common';
import {
  BoundedString,
  NonEmptyStringSchema,
  REJECT_EXCESS_PROPERTIES,
} from './internal';
import { Schema } from 'effect';

// New-lead email notifications. Personal preferences stay separate from
// installation-level email settings; "availability" is a closed, safe summary
// computed from the saved provider configuration.
export const NotificationAvailabilitySchema = Schema.Literals([
  'configured',
  'disabled',
  'misconfigured',
]);
export type NotificationAvailability = Schema.Schema.Type<
  typeof NotificationAvailabilitySchema
>;

export const UpdateNotificationPreferenceRequestSchema = Schema.Struct({
  newLeadEmail: Schema.Boolean,
}).annotate({
  description:
    'Opt in or out of email alerts for newly created leads. Defaults off.',
});
export type UpdateNotificationPreferenceRequest = Schema.Schema.Type<
  typeof UpdateNotificationPreferenceRequestSchema
>;

// Installation-wide configuration. `expectedRevision` is a server-generated,
// user-visible compare-and-swap token; the credential operation is explicit
// keep/replace/remove so a blank key field can never erase a stored
// credential. The persisted document is validated against this schema on
// every read and before every write; a corrupt or unsupported document fails
// closed and is never silently reset.
export const EmailSettingsProviderSchema = Schema.Literals([
  'cloudflare',
  'disabled',
  'resend',
]);
export type EmailSettingsProvider = Schema.Schema.Type<
  typeof EmailSettingsProviderSchema
>;

export const EmailCredentialOperationSchema = Schema.Struct({
  operation: Schema.Literals(['keep', 'remove', 'replace']),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({
  description:
    'keep preserves the stored provider key, replace stores the supplied value, remove deletes it and disables the affected provider.',
});

export const UpdateEmailSettingsRequestSchema = Schema.Struct({
  credential: EmailCredentialOperationSchema,
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  fromEmail: Schema.optional(
    Schema.NullOr(EmailSchema.check(Schema.isMaxLength(320))),
  ),
  fromName: Schema.optional(
    Schema.NullOr(NonEmptyStringSchema.check(Schema.isMaxLength(120))),
  ),
  provider: EmailSettingsProviderSchema,
}).annotate({
  description:
    'Saves installation email settings. Never sends a test automatically and never accepts a client-chosen origin or provider base URL.',
});
export type EmailCredentialOperation = Schema.Schema.Type<
  typeof EmailCredentialOperationSchema
>;
export type UpdateEmailSettingsRequest = Schema.Schema.Type<
  typeof UpdateEmailSettingsRequestSchema
>;

export const SendEmailTestRequestSchema = Schema.Struct({
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  requestId: NonEmptyStringSchema.check(Schema.isMaxLength(64)),
}).annotate({
  description:
    'Sends one optional test message to the signed-in administrator using the saved configuration; requestId deduplicates retries.',
});
export type SendEmailTestRequest = Schema.Schema.Type<
  typeof SendEmailTestRequestSchema
>;

// --- Installation configuration document ------------------------------------

export const INSTALLATION_CONFIG_VERSION = 2;

// Bounded rolling-window limits for optional test sends. The persisted
// `recent` array is pruned on every reservation and capped by its schema.
export const EMAIL_TEST_MIN_INTERVAL_MS = 60_000;
export const EMAIL_TEST_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const EMAIL_TEST_ROLLING_LIMIT = 5;
export const EMAIL_TEST_RECENT_CAP = 5;

export const EncryptedCredentialSchema = Schema.Struct({
  ciphertext: BoundedString(4_096).check(Schema.isMinLength(1)),
  keyVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  nonce: BoundedString(512).check(Schema.isMinLength(1)),
});
export type EncryptedCredential = Schema.Schema.Type<
  typeof EncryptedCredentialSchema
>;

export const InstallationEmailConfigSchema = Schema.Struct({
  canonicalOrigin: Schema.NullOr(BoundedString(2_048)),
  credential: Schema.NullOr(EncryptedCredentialSchema),
  fromEmail: Schema.NullOr(BoundedString(320)),
  fromName: Schema.NullOr(BoundedString(120)),
  provider: EmailSettingsProviderSchema,
});
export type InstallationEmailConfig = Schema.Schema.Type<
  typeof InstallationEmailConfigSchema
>;

export const EmailTestOutcomeSchema = Schema.Literals([
  'accepted',
  'ambiguous',
  'configuration_error',
  'rejected',
  'sending',
]);
export type EmailTestOutcome = Schema.Schema.Type<
  typeof EmailTestOutcomeSchema
>;

// One compact test attempt: the reserved request id, the actor who owns it,
// the saved email revision it belongs to, and the reported outcome. Only the
// most recent attempt is retained, so duplicate protection is finite and
// documented rather than a durable replay engine.
export const EmailTestStateSchema = Schema.Struct({
  actorUserId: BoundedString(64).check(Schema.isMinLength(1)),
  at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  configRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  outcome: EmailTestOutcomeSchema,
  provider: Schema.NullOr(Schema.Literals(['cloudflare', 'resend'])),
  providerMessageId: Schema.NullOr(BoundedString(256)),
  reasonCode: Schema.NullOr(BoundedString(64)),
  requestId: NonEmptyStringSchema.check(Schema.isMaxLength(64)),
});
export type EmailTestState = Schema.Schema.Type<typeof EmailTestStateSchema>;

export const EmailTestRateEntrySchema = Schema.Struct({
  actorUserId: BoundedString(64).check(Schema.isMinLength(1)),
  at: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type EmailTestRateEntry = Schema.Schema.Type<
  typeof EmailTestRateEntrySchema
>;

export const InstallationConfigSchema = Schema.Struct({
  email: InstallationEmailConfigSchema,
  emailTest: Schema.Struct({
    last: Schema.NullOr(EmailTestStateSchema),
    recent: Schema.Array(EmailTestRateEntrySchema).check(
      Schema.isMaxLength(EMAIL_TEST_RECENT_CAP),
    ),
  }),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  version: Schema.Literal(INSTALLATION_CONFIG_VERSION),
});
export type InstallationConfig = Schema.Schema.Type<
  typeof InstallationConfigSchema
>;

/**
 * Fixed, redacted validation failure; never carries rejected values.
 */
export class InstallationConfigValidationError extends Error {
  constructor() {
    super('The installation configuration is invalid.');
    this.name = 'InstallationConfigValidationError';
  }
}

export const DEFAULT_INSTALLATION_CONFIG: InstallationConfig = Object.freeze({
  email: Object.freeze({
    canonicalOrigin: null,
    credential: null,
    fromEmail: null,
    fromName: null,
    provider: 'disabled',
  }),
  emailTest: Object.freeze({ last: null, recent: Object.freeze([]) }),
  revision: 0,
  version: INSTALLATION_CONFIG_VERSION,
}) as InstallationConfig;

/**
 * v1 stored an installation-wide `enabled` boolean next to the provider. v2
 * folds that state into `provider`: a paused v1 document becomes `disabled`
 * while its sender and credential are retained, so switching a method back on
 * restores the previous setup. Anything that is not a well-formed v1 document
 * is returned unchanged and rejected by the authoritative decoder.
 */
const migrateInstallationConfigV1 = (value: unknown): unknown => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1
  ) {
    return value;
  }

  const email = (value as { email?: unknown }).email;
  if (typeof email !== 'object' || email === null || Array.isArray(email)) {
    return value;
  }

  const { enabled, ...rest } = email as Record<string, unknown>;
  if (typeof enabled !== 'boolean') {
    return value;
  }

  return {
    ...(value as Record<string, unknown>),
    email: {
      ...rest,
      provider: enabled ? rest.provider : 'disabled',
    },
    version: INSTALLATION_CONFIG_VERSION,
  };
};

/**
 * Decodes one persisted configuration document from an already-parsed Drizzle
 * JSON value. Raw TEXT parsing belongs to the database driver or tooling.
 * Returns null for malformed JSON, an unknown schema version, an unknown
 * property at any level, or any shape that violates the bounded schema, so
 * callers can fail closed without echoing raw content.
 */
export const decodeInstallationConfig = (
  value: unknown,
): InstallationConfig | null => {
  try {
    return Schema.decodeUnknownSync(InstallationConfigSchema)(
      migrateInstallationConfigV1(value),
      REJECT_EXCESS_PROPERTIES,
    );
  } catch {
    return null;
  }
};

/**
 * Validates a configuration document against the authoritative schema,
 * including excess-property rejection at every level, and returns the
 * validated value for Drizzle to serialize. Throws a fixed redacted error on
 * failure and never includes rejected values.
 */
export const validateInstallationConfig = (
  value: unknown,
): InstallationConfig => {
  try {
    return Schema.decodeUnknownSync(InstallationConfigSchema)(
      value,
      REJECT_EXCESS_PROPERTIES,
    );
  } catch {
    throw new InstallationConfigValidationError();
  }
};

// --- Notification response contracts ----------------------------------------

// The SPA derives its types from these schemas; the server command views are
// typed by the same aliases, so the two sides cannot drift without a type
// error. Credentials are never part of a response contract.
export const EmailTestViewSchema = Schema.Struct({
  at: Schema.NullOr(Schema.String),
  outcome: EmailTestOutcomeSchema,
  providerMessageId: Schema.NullOr(Schema.String),
  reasonCode: Schema.NullOr(Schema.String),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});
export type EmailTestView = Schema.Schema.Type<typeof EmailTestViewSchema>;

export const EmailSettingsViewSchema = Schema.Struct({
  canonicalOrigin: Schema.String,
  environment: Schema.Struct({
    hasCloudflareBinding: Schema.Boolean,
    hasEncryptionKey: Schema.Boolean,
  }),
  fromEmail: Schema.NullOr(Schema.String),
  fromName: Schema.NullOr(Schema.String),
  hasApiKey: Schema.Boolean,
  provider: EmailSettingsProviderSchema,
  readiness: Schema.Struct({
    availability: NotificationAvailabilitySchema,
    reasonCode: Schema.NullOr(Schema.String),
  }),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  test: Schema.NullOr(EmailTestViewSchema),
});
export type EmailSettingsView = Schema.Schema.Type<
  typeof EmailSettingsViewSchema
>;

export const NotificationPreferenceViewSchema = Schema.Struct({
  availability: NotificationAvailabilitySchema,
  newLeadEmail: Schema.Boolean,
  provider: Schema.NullOr(Schema.Literals(['cloudflare', 'resend'])),
});
export type NotificationPreferenceView = Schema.Schema.Type<
  typeof NotificationPreferenceViewSchema
>;
