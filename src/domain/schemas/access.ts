import { NonEmptyStringSchema } from './internal';
import { Schema } from 'effect';

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
