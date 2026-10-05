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

const NonEmptyStringSchema = Schema.String.pipe(
  Schema.trimmed(),
  Schema.minLength(1),
);

export const EmailSchema = NonEmptyStringSchema.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u),
).annotations({ description: 'A valid email address.' });

export const RecordIdSchema = Schema.String.pipe(
  Schema.pattern(/[0-7][\dA-HJKMNP-TV-Z]{25}/u),
  Schema.filter((value) => value.length === 26),
).annotations({ description: 'A ULID record identifier.' });

// Free-form per-lead custom fields: a JSON document with no definition
// registry.
export const CustomFieldValuesSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type CustomFieldValues = Schema.Schema.Type<
  typeof CustomFieldValuesSchema
>;

// SDK diagnostics: names of fields the browser SDK refused to send, and why.
// Values are never included. Bounded because the sender controls the list.
export const SkippedFieldSchema = Schema.Struct({
  name: NonEmptyStringSchema.pipe(Schema.maxLength(120)),
  reason: Schema.Literal('sensitive', 'unmarked'),
});
export const SkippedFieldsSchema = Schema.Array(SkippedFieldSchema).pipe(
  Schema.maxItems(50),
);
export type SkippedField = Schema.Schema.Type<typeof SkippedFieldSchema>;

// Intake is the flat lead payload: one submission creates one lead. The old
// contact + opportunity shape is gone; `customFields` is stored as a JSON
// document on the lead with no definition registry.
export const IntakeRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: EmailSchema,
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  firstName: Schema.optional(NonEmptyStringSchema),
  lastName: Schema.optional(NonEmptyStringSchema),
  skippedFields: Schema.optional(SkippedFieldsSchema),
  source: NonEmptyStringSchema,
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
  duplicateCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  email: Schema.NullOr(Schema.String),
  estimatedValue: Schema.NullOr(Schema.Number),
  firstName: Schema.NullOr(Schema.String),
  id: RecordIdSchema,
  lastName: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  rawPayload: Schema.optional(Schema.NullOr(CustomFieldValuesSchema)),
  skippedFields: Schema.NullOr(SkippedFieldsSchema),
  source: NonEmptyStringSchema,
  tokenId: Schema.NullOr(Schema.String),
  tokenName: Schema.optional(Schema.NullOr(Schema.String)),
  tokenType: Schema.optional(Schema.NullOr(Schema.Literal('api', 'browser'))),
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
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(100),
    ),
  ),
  query: Schema.optional(NonEmptyStringSchema),
});
export type ListLeadsQuery = Schema.Schema.Type<typeof ListLeadsQuerySchema>;

// Lead writes. `CreateLeadRequestSchema` covers manual/operator entry; intake
// has its own flat `IntakeRequestSchema` because it is the
// unauthenticated-token contract.
export const CreateLeadRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(EmailSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  firstName: Schema.optional(NonEmptyStringSchema),
  lastName: Schema.optional(NonEmptyStringSchema),
  source: Schema.optional(NonEmptyStringSchema),
});
export type CreateLeadRequest = Schema.Schema.Type<
  typeof CreateLeadRequestSchema
>;

export const UpdateLeadRequestSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(Schema.NullOr(EmailSchema)),
  estimatedValue: Schema.optional(
    Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
  ),
  firstName: Schema.optional(Schema.NullOr(NonEmptyStringSchema)),
  lastName: Schema.optional(Schema.NullOr(NonEmptyStringSchema)),
  source: Schema.optional(NonEmptyStringSchema),
});
export type UpdateLeadRequest = Schema.Schema.Type<
  typeof UpdateLeadRequestSchema
>;

export const BulkDeleteLeadsRequestSchema = Schema.Struct({
  ids: Schema.Array(RecordIdSchema).pipe(
    Schema.minItems(1),
    Schema.maxItems(100),
  ),
});
export type BulkDeleteLeadsRequest = Schema.Schema.Type<
  typeof BulkDeleteLeadsRequestSchema
>;

export const CreateLeadActivityRequestSchema = Schema.Struct({
  body: NonEmptyStringSchema,
  kind: Schema.optional(Schema.Literal('note', 'contact_attempt')),
});
export type CreateLeadActivityRequest = Schema.Schema.Type<
  typeof CreateLeadActivityRequestSchema
>;

// A future UTC ISO-8601 date (optional time, offset, or Z) for expiry
// overrides on API tokens and staff invitations.
const FutureIsoDateSchema = Schema.String.pipe(
  Schema.pattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u,
  ),

  Schema.filter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > Date.now();
  }),
);

export const CreateTokenRequestSchema = Schema.Struct({
  expiresAt: Schema.optional(Schema.NullOr(FutureIsoDateSchema)),
  name: NonEmptyStringSchema,
  type: Schema.optional(Schema.Literal('api', 'browser')),
}).annotations({
  description:
    'Creates an intake token (90 days by default; null never expires). Browser tokens are safe to embed in a website and can only create leads.',
});
export type CreateTokenRequest = Schema.Schema.Type<
  typeof CreateTokenRequestSchema
>;

export const CreateInviteRequestSchema = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDateSchema),
  name: NonEmptyStringSchema,
}).annotations({
  description: 'Creates a single-use staff invitation (7 days by default).',
});
export type CreateInviteRequest = Schema.Schema.Type<
  typeof CreateInviteRequestSchema
>;

export const ValidateInviteRequestSchema = Schema.Struct({
  token: Schema.String,
}).annotations({
  description:
    'Checks a registration grant without consuming it. Any token is an input; only 200 vs 403 differ.',
});
export type ValidateInviteRequest = Schema.Schema.Type<
  typeof ValidateInviteRequestSchema
>;

export const SetStaffDisabledRequestSchema = Schema.Struct({
  disabled: Schema.Boolean,
}).annotations({
  description:
    'Enables or disables a staff account. Disabling also revokes every session of that account; re-enabling preserves the credentials but never restores old sessions.',
});
export type SetStaffDisabledRequest = Schema.Schema.Type<
  typeof SetStaffDisabledRequestSchema
>;

export const PaginationSchema = Schema.Struct({
  cursor: Schema.optional(RecordIdSchema),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
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
  name: NonEmptyStringSchema.pipe(Schema.maxLength(200)),
});
export type UpdateAccountProfileRequest = Schema.Schema.Type<
  typeof UpdateAccountProfileRequestSchema
>;

export const ChangeAccountPasswordRequestSchema = Schema.Struct({
  currentPassword: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(CURRENT_PASSWORD_MAX),
  ),
  newPassword: Schema.String.pipe(
    Schema.minLength(PASSWORD_MIN),
    Schema.maxLength(PASSWORD_MAX),
    Schema.filter((value) => value.trim().length > 0),
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
