import {
  CURRENT_PASSWORD_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from '../password-policy';
import { NonEmptyStringSchema } from './internal';
import { Schema } from 'effect';

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
