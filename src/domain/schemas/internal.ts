import { Schema } from 'effect';

export const NonEmptyStringSchema = Schema.Trimmed.check(Schema.isMinLength(1));

export const BoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMaxLength(maximum));

/**
 * Shared parse options for every configuration decode/encode: unknown
 * properties at any struct level are rejected instead of stripped, so a
 * document written by a newer schema is never silently rewritten without the
 * data it carried.
 */
export const REJECT_EXCESS_PROPERTIES = {
  onExcessProperty: 'error',
} as const;
