import {
  BoundedString,
  NonEmptyStringSchema,
  REJECT_EXCESS_PROPERTIES,
} from './internal';
import { Schema } from 'effect';

/**
 * Fixed, redacted audit validation failure; never carries rejected values.
 */
export class AuditValidationError extends Error {
  constructor() {
    super('The audit record is invalid.');
    this.name = 'AuditValidationError';
  }
}

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
