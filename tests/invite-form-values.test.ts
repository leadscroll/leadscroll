import { CreateInviteRequestSchema } from '@/domain/schemas';
import { toLocalInputValue } from '@/lib/datetime';
import {
  emptyInviteFormValues,
  toCreateInviteRequest,
} from '@/lib/inviteFormValues';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

const future = (): string =>
  toLocalInputValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000));

describe('invite form values', () => {
  test('converts a local expiration to a UTC ISO string', async () => {
    const expiration = future();
    const input = toCreateInviteRequest({
      ...emptyInviteFormValues(expiration),
      name: '  Weekend onboarding ',
    });

    expect(input).toEqual({
      expiresAt: new Date(expiration).toISOString(),
      name: 'Weekend onboarding',
    });
    await expect(
      Schema.decodeUnknownPromise(CreateInviteRequestSchema, {
        onExcessProperty: 'error',
      })(input),
    ).resolves.toEqual(input);
  });

  test('omits an empty expiration so the 7-day default applies', () => {
    const input = toCreateInviteRequest({
      ...emptyInviteFormValues(''),
      name: 'Weekend onboarding',
    });

    expect(input.expiresAt).toBeUndefined();
    expect(JSON.parse(JSON.stringify(input))).toEqual({
      name: 'Weekend onboarding',
    });
  });
});
