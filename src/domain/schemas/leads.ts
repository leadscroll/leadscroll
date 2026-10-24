import {
  CustomFieldValuesSchema,
  EmailSchema,
  RecordIdSchema,
  SkippedFieldsSchema,
} from './common';
import { NonEmptyStringSchema } from './internal';
import { TagNameSchema, TagViewSchema } from './tags';
import { Schema } from 'effect';

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

// Leads. Response contracts are the wire shape (ISO-8601 strings, JSON-encoded
// dates) shared with the SPA; request contracts are decoded by the API boundary
// before commands run.
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
