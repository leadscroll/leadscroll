import { NonEmptyStringSchema } from './internal';
import { Schema } from 'effect';

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

// Response contracts describe the wire shape (ISO-8601 strings, JSON-encoded
// dates) shared with the SPA; request contracts are decoded by the API boundary
// before commands run.
export const HealthSchema = Schema.Struct({ ok: Schema.Boolean });

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
