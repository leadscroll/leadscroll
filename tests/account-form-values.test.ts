import {
  toChangeAccountPasswordRequest,
  toUpdateAccountProfileRequest,
} from '@/account/accountFormValues';
import {
  ChangeAccountPasswordRequestSchema,
  UpdateAccountProfileRequestSchema,
} from '@/domain/schemas';
import { Schema } from 'effect';
import { expect, test } from 'vitest';

test('profile mapper trims the name and emits only the profile contract', () => {
  const input = toUpdateAccountProfileRequest({ name: '  Staff Name  ' });
  expect(input).toEqual({ name: 'Staff Name' });
  expect(
    Schema.decodeUnknownSync(UpdateAccountProfileRequestSchema, {
      onExcessProperty: 'error',
    })(input),
  ).toEqual(input);
});

test('password mapper preserves whitespace and omits confirmation', () => {
  const input = toChangeAccountPasswordRequest({
    confirmation: ' new-password ',
    currentPassword: ' current-password ',
    newPassword: ' new-password ',
  });
  expect(input).toEqual({
    currentPassword: ' current-password ',
    newPassword: ' new-password ',
  });
  expect(
    Schema.decodeUnknownSync(ChangeAccountPasswordRequestSchema, {
      onExcessProperty: 'error',
    })(input),
  ).toEqual(input);
});
