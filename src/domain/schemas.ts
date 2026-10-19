import {
  CURRENT_PASSWORD_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from './password-policy';
import { Schema } from 'effect';

// Naming: runtime schema values end in `Schema` (`CreateLeadRequestSchema`,
// `LeadViewSchema`); derived TypeScript types use the plain domain name
// (`CreateLeadRequest`, `LeadView`). Request schemas validate wire input and
// their type is what commands receive; response schemas are the wire shape
// shared with the SPA. No `Input`/`I` markers: a derived type is not always
// an input.

const NonEmptyStringSchema = Schema.Trimmed.check(Schema.isMinLength(1));

export const EmailSchema = NonEmptyStringSchema.check(
  Schema.isPattern(/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u),
).annotate({ description: 'A valid email address.' });

export const RecordIdSchema = Schema.String.check(
  Schema.isPattern(/[0-7][\dA-HJKMNP-TV-Z]{25}/u),
  Schema.makeFilter((value) => value.length === 26),
).annotate({ description: 'A ULID record identifier.' });

// Free-form per-lead custom fields: a JSON document with no definition
// registry.
export const CustomFieldValuesSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
);
export type CustomFieldValues = Schema.Schema.Type<
  typeof CustomFieldValuesSchema
>;

// SDK diagnostics: names of fields the browser SDK refused to send, and why.
// Values are never included. Bounded because the sender controls the list.
export const SkippedFieldSchema = Schema.Struct({
  name: NonEmptyStringSchema.check(Schema.isMaxLength(120)),
  reason: Schema.Literals(['sensitive', 'unmarked']),
});
export const SkippedFieldsSchema = Schema.Array(SkippedFieldSchema).check(
  Schema.isMaxLength(50),
);
export type SkippedField = Schema.Schema.Type<typeof SkippedFieldSchema>;

// Tags. `prefix:value` tags share a scope and are exclusive per lead; plain
// tags are standalone. Colors are a closed palette shared by the UI.
export const TAG_COLORS = ['teal', 'blue', 'violet', 'amber'] as const;
export const TagColorSchema = Schema.Literals(TAG_COLORS);
export type TagColor = Schema.Schema.Type<typeof TagColorSchema>;

// A full tag name is `prefix:value` or a plain value: at most 30 characters
// for the scope, 40 for the value, plus one delimiter. Parsing (rather than
// this bound) enforces the single delimiter.
export const TagNameSchema = NonEmptyStringSchema.check(Schema.isMaxLength(71));
export const TagScopePrefixSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(30),
);

export const TagScopeViewSchema = Schema.Struct({
  color: TagColorSchema,
  createdAt: Schema.String,
  id: RecordIdSchema,
  prefix: Schema.String,
  updatedAt: Schema.String,
});
export type TagScopeView = Schema.Schema.Type<typeof TagScopeViewSchema>;

export const TagViewSchema = Schema.Struct({
  color: TagColorSchema,
  createdAt: Schema.String,
  id: RecordIdSchema,
  label: Schema.String,
  name: Schema.String,
  scopeId: Schema.NullOr(RecordIdSchema),
  updatedAt: Schema.String,
});
export type TagView = Schema.Schema.Type<typeof TagViewSchema>;

// Catalog rows additionally report how many active accessible leads use them.
export const CatalogTagViewSchema = Schema.Struct({
  ...TagViewSchema.fields,
  leadCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});
export type CatalogTagView = Schema.Schema.Type<typeof CatalogTagViewSchema>;

export const TagCatalogSchema = Schema.Struct({
  scopes: Schema.Array(TagScopeViewSchema),
  tags: Schema.Array(CatalogTagViewSchema),
});
export type TagCatalog = Schema.Schema.Type<typeof TagCatalogSchema>;

export const CreateTagRequestSchema = Schema.Struct({ name: TagNameSchema });
export type CreateTagRequest = Schema.Schema.Type<
  typeof CreateTagRequestSchema
>;

export const UpdateTagRequestSchema = Schema.Struct({
  color: Schema.optional(TagColorSchema),
  name: Schema.optional(TagNameSchema),
});
export type UpdateTagRequest = Schema.Schema.Type<
  typeof UpdateTagRequestSchema
>;

export const UpdateTagScopeRequestSchema = Schema.Struct({
  color: Schema.optional(TagColorSchema),
  prefix: Schema.optional(TagScopePrefixSchema),
});
export type UpdateTagScopeRequest = Schema.Schema.Type<
  typeof UpdateTagScopeRequestSchema
>;

export const SetLeadTagsRequestSchema = Schema.Struct({
  tagIds: Schema.Array(RecordIdSchema).check(Schema.isMaxLength(100)),
});
export type SetLeadTagsRequest = Schema.Schema.Type<
  typeof SetLeadTagsRequestSchema
>;

export const BulkTagRequestSchema = Schema.Struct({
  ids: Schema.Array(RecordIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  mode: Schema.Literals(['add', 'remove']),
  tagIds: Schema.Array(RecordIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type BulkTagRequest = Schema.Schema.Type<typeof BulkTagRequestSchema>;

// Intake is the flat lead payload: one submission creates one lead. The old
// contact + opportunity shape is gone; `customFields` is stored as a JSON
// document on the lead with no definition registry.
export const IntakeRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: EmailSchema,
  estimatedValue: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  firstName: Schema.optional(NonEmptyStringSchema),
  lastName: Schema.optional(NonEmptyStringSchema),
  skippedFields: Schema.optional(SkippedFieldsSchema),
  source: NonEmptyStringSchema,
  tags: Schema.optional(
    Schema.Array(TagNameSchema).check(Schema.isMaxLength(100)),
  ),
});
export type IntakeRequest = Schema.Schema.Type<typeof IntakeRequestSchema>;

// Response contracts describe the wire shape (ISO-8601 strings, JSON-encoded
// dates) shared with the SPA; request contracts validate Elysia input through
// Standard Schema.
export const HealthSchema = Schema.Struct({ ok: Schema.Boolean });

// Leads. Response contracts are the wire shape (ISO-8601 strings, JSON-encoded
// dates) shared with the SPA; request contracts validate Elysia input through
// Standard Schema.
export const LeadViewSchema = Schema.Struct({
  createdAt: Schema.String,
  customFields: CustomFieldValuesSchema,
  deletedAt: Schema.NullOr(Schema.String),
  duplicateCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  email: Schema.NullOr(Schema.String),
  estimatedValue: Schema.NullOr(Schema.Number),
  firstName: Schema.NullOr(Schema.String),
  id: RecordIdSchema,
  lastName: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  rawPayload: Schema.optional(Schema.NullOr(CustomFieldValuesSchema)),
  skippedFields: Schema.NullOr(SkippedFieldsSchema),
  source: NonEmptyStringSchema,
  tags: Schema.Array(TagViewSchema),
  tokenId: Schema.NullOr(Schema.String),
  tokenName: Schema.optional(Schema.NullOr(Schema.String)),
  tokenType: Schema.optional(
    Schema.NullOr(Schema.Literals(['api', 'browser'])),
  ),
  updatedAt: Schema.String,
});
export type LeadView = Schema.Schema.Type<typeof LeadViewSchema>;

export const LeadsSchema = Schema.Struct({
  data: Schema.Array(LeadViewSchema),
  nextCursor: Schema.NullOr(Schema.String),
});
export type LeadsPage = Schema.Schema.Type<typeof LeadsSchema>;

export const LeadActivitySchema = Schema.Struct({
  actorEmail: Schema.NullOr(Schema.String),
  body: NonEmptyStringSchema,
  createdAt: Schema.String,
  id: RecordIdSchema,
  kind: Schema.String,
});
export type LeadActivity = Schema.Schema.Type<typeof LeadActivitySchema>;

export const LeadActivitiesSchema = Schema.Struct({
  data: Schema.Array(LeadActivitySchema),
});

export const ListLeadsQuerySchema = Schema.Struct({
  cursor: Schema.optional(NonEmptyStringSchema),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100),
    ),
  ),
  query: Schema.optional(NonEmptyStringSchema),
  // Exact-tag and any-tag-in-scope filters are applied server-side before the
  // keyset page is cut, never against only the loaded rows.
  tag: Schema.optional(RecordIdSchema),
  tagScope: Schema.optional(RecordIdSchema),
});
export type ListLeadsQuery = Schema.Schema.Type<typeof ListLeadsQuerySchema>;

// Lead writes. `CreateLeadRequestSchema` covers manual/operator entry; intake
// has its own flat `IntakeRequestSchema` because it is the
// unauthenticated-token contract.
export const CreateLeadRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(EmailSchema),
  estimatedValue: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  firstName: Schema.optional(NonEmptyStringSchema),
  lastName: Schema.optional(NonEmptyStringSchema),
  source: Schema.optional(NonEmptyStringSchema),
  tags: Schema.optional(
    Schema.Array(TagNameSchema).check(Schema.isMaxLength(100)),
  ),
});
export type CreateLeadRequest = Schema.Schema.Type<
  typeof CreateLeadRequestSchema
>;

export const UpdateLeadRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(Schema.NullOr(EmailSchema)),
  estimatedValue: Schema.optional(
    Schema.NullOr(
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  firstName: Schema.optional(Schema.NullOr(NonEmptyStringSchema)),
  lastName: Schema.optional(Schema.NullOr(NonEmptyStringSchema)),
  source: Schema.optional(NonEmptyStringSchema),
});
export type UpdateLeadRequest = Schema.Schema.Type<
  typeof UpdateLeadRequestSchema
>;

export const BulkDeleteLeadsRequestSchema = Schema.Struct({
  ids: Schema.Array(RecordIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type BulkDeleteLeadsRequest = Schema.Schema.Type<
  typeof BulkDeleteLeadsRequestSchema
>;

export const CreateLeadActivityRequestSchema = Schema.Struct({
  body: NonEmptyStringSchema,
  kind: Schema.optional(Schema.Literals(['note', 'contact_attempt'])),
});
export type CreateLeadActivityRequest = Schema.Schema.Type<
  typeof CreateLeadActivityRequestSchema
>;

// A future UTC ISO-8601 date (optional time, offset, or Z) for expiry
// overrides on API tokens and staff invitations.
const FutureIsoDateSchema = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u,
  ),
  Schema.makeFilter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > Date.now();
  }),
);

export const CreateTokenRequestSchema = Schema.Struct({
  expiresAt: Schema.optional(Schema.NullOr(FutureIsoDateSchema)),
  name: NonEmptyStringSchema,
  type: Schema.optional(Schema.Literals(['api', 'browser'])),
}).annotate({
  description:
    'Creates an intake token (90 days by default; null never expires). Browser tokens are safe to embed in a website and can only create leads.',
});
export type CreateTokenRequest = Schema.Schema.Type<
  typeof CreateTokenRequestSchema
>;

export const CreateInviteRequestSchema = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDateSchema),
  name: NonEmptyStringSchema,
}).annotate({
  description: 'Creates a single-use staff invitation (7 days by default).',
});
export type CreateInviteRequest = Schema.Schema.Type<
  typeof CreateInviteRequestSchema
>;

export const ValidateInviteRequestSchema = Schema.Struct({
  token: Schema.String,
}).annotate({
  description:
    'Checks a registration grant without consuming it. Any token is an input; only 200 vs 403 differ.',
});
export type ValidateInviteRequest = Schema.Schema.Type<
  typeof ValidateInviteRequestSchema
>;

export const SetStaffDisabledRequestSchema = Schema.Struct({
  disabled: Schema.Boolean,
}).annotate({
  description:
    'Enables or disables a staff account. Disabling also revokes every session of that account; re-enabling preserves the credentials but never restores old sessions.',
});
export type SetStaffDisabledRequest = Schema.Schema.Type<
  typeof SetStaffDisabledRequestSchema
>;

export const PaginationSchema = Schema.Struct({
  cursor: Schema.optional(RecordIdSchema),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  query: Schema.optional(NonEmptyStringSchema),
});

export const ApiErrorSchema = Schema.Struct({
  code: NonEmptyStringSchema,
  details: Schema.optional(Schema.Unknown),
  message: NonEmptyStringSchema,
});

export type ApiError = Schema.Schema.Type<typeof ApiErrorSchema>;

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

// Self-service account contracts. Better Auth session ids are opaque strings.
export const UpdateAccountProfileRequestSchema = Schema.Struct({
  name: NonEmptyStringSchema.check(Schema.isMaxLength(200)),
});
export type UpdateAccountProfileRequest = Schema.Schema.Type<
  typeof UpdateAccountProfileRequestSchema
>;

export const ChangeAccountPasswordRequestSchema = Schema.Struct({
  currentPassword: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CURRENT_PASSWORD_MAX),
  ),
  newPassword: Schema.String.check(
    Schema.isMinLength(PASSWORD_MIN),
    Schema.isMaxLength(PASSWORD_MAX),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
});
export type ChangeAccountPasswordRequest = Schema.Schema.Type<
  typeof ChangeAccountPasswordRequestSchema
>;

export const AccountSessionViewSchema = Schema.Struct({
  createdAt: Schema.String,
  current: Schema.Boolean,
  expiresAt: Schema.String,
  id: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
});
export type AccountSessionView = Schema.Schema.Type<
  typeof AccountSessionViewSchema
>;

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

const BoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMaxLength(maximum));

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
 * Shared parse options for every configuration decode/encode: unknown
 * properties at any struct level are rejected instead of stripped, so a
 * document written by a newer schema is never silently rewritten without the
 * data it carried.
 */
const REJECT_EXCESS_PROPERTIES = { onExcessProperty: 'error' } as const;

/**
 * Fixed, redacted audit validation failure; never carries rejected values.
 */
export class AuditValidationError extends Error {
  constructor() {
    super('The audit record is invalid.');
    this.name = 'AuditValidationError';
  }
}

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

// --- Generic audit log ------------------------------------------------------

/**
 * Safe, bounded audit values: scalars only. Producers are responsible for
 * redacting secrets before they reach this contract; the schema bounds the
 * size so an audit row cannot grow without limit.
 */
export const AuditValueSchema = Schema.NullOr(
  Schema.Union([
    BoundedString(512),
    Schema.Number.check(Schema.isFinite()),
    Schema.Boolean,
  ]),
);
export type AuditValue = Schema.Schema.Type<typeof AuditValueSchema>;

export const AuditChangeSchema = Schema.Struct({
  after: AuditValueSchema,
  before: AuditValueSchema,
  field: NonEmptyStringSchema.check(Schema.isMaxLength(128)),
});
export type AuditChange = Schema.Schema.Type<typeof AuditChangeSchema>;

export const AuditChangesSchema = Schema.Array(AuditChangeSchema).check(
  Schema.isMaxLength(32),
);

export const AuditWriteSchema = Schema.Struct({
  action: NonEmptyStringSchema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9_.]*$/u),
  ),
  changes: AuditChangesSchema,
  resourceId: Schema.NullOr(NonEmptyStringSchema.check(Schema.isMaxLength(64))),
  resourceType: NonEmptyStringSchema.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z][a-z0-9_.]*$/u),
  ),
});
export type AuditWrite = Schema.Schema.Type<typeof AuditWriteSchema>;

export const AuditRecordSchema = Schema.Struct({
  action: Schema.String,
  actorUserId: Schema.NullOr(Schema.String),
  changes: AuditChangesSchema,
  createdAt: Schema.String,
  id: Schema.String,
  resourceId: Schema.NullOr(Schema.String),
  resourceType: Schema.String,
});
export type AuditRecord = Schema.Schema.Type<typeof AuditRecordSchema>;

/**
 * Validates bounded audit changes for a producer. Throws a fixed redacted
 * error on failure and never includes rejected values.
 */
export const validateAuditChanges = (
  changes: unknown,
): readonly AuditChange[] => {
  try {
    return Schema.decodeUnknownSync(AuditChangesSchema)(
      changes,
      REJECT_EXCESS_PROPERTIES,
    );
  } catch {
    throw new AuditValidationError();
  }
};

/**
 * Validates one audit producer record against the bounded schema before it
 * reaches D1. Throws a fixed redacted error on failure and never includes
 * rejected values; repository helpers call this for every audited mutation.
 */
export const validateAuditWrite = (record: unknown): AuditWrite => {
  try {
    return Schema.decodeUnknownSync(AuditWriteSchema)(
      record,
      REJECT_EXCESS_PROPERTIES,
    );
  } catch {
    throw new AuditValidationError();
  }
};

/**
 * Decodes bounded audit changes from an already-parsed Drizzle JSON value. Returns null for malformed data
 * instead of echoing it.
 */
export const decodeAuditChanges = (
  value: unknown,
): null | readonly AuditChange[] => {
  try {
    return Schema.decodeUnknownSync(AuditChangesSchema)(
      value,
      REJECT_EXCESS_PROPERTIES,
    );
  } catch {
    return null;
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
