import { CreateTokenRequestSchema } from '@/domain/schemas';
import { toLocalInputValue } from '@/lib/datetime';
import {
  emptyTokenFormValues,
  toCreateTokenRequest,
} from '@/lib/tokenFormValues';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

const future = (): string =>
  toLocalInputValue(new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000));

describe('token form values', () => {
  test('defaults to the 90-day preset', () => {
    expect(emptyTokenFormValues('').expirationMode).toBe('90');
  });

  test.each([
    ['7', '2026-10-14T12:34:00.000Z'],
    ['30', '2026-11-06T12:34:00.000Z'],
    ['90', '2027-01-05T12:34:00.000Z'],
  ] as const)(
    'maps the %s-day preset from the selected reference instant',
    (expirationMode, expected) => {
      const reference = Date.parse('2026-10-07T12:34:00.000Z');
      const input = toCreateTokenRequest(
        {
          ...emptyTokenFormValues('invalid stale custom date'),
          expirationMode,
          name: 'Preset',
        },
        reference,
      );
      expect(input.expiresAt).toBe(expected);
      expect(input).not.toHaveProperty('expirationMode');
    },
  );

  test('Never ignores a stale custom date', () => {
    expect(
      toCreateTokenRequest({
        ...emptyTokenFormValues('invalid'),
        expirationMode: 'never',
      }).expiresAt,
    ).toBeNull();
  });
  test('sends null expiresAt when Never expires is chosen', async () => {
    const input = toCreateTokenRequest({
      ...emptyTokenFormValues(future()),
      expirationMode: 'never',
      name: '  Website form  ',
    });

    expect(input).toEqual({
      expiresAt: null,
      name: 'Website form',
      type: 'api',
    });
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequestSchema, {
        onExcessProperty: 'error',
      })(input),
    ).resolves.toEqual(input);
  });

  test('converts a local expiration to a UTC ISO string', async () => {
    const expiration = future();
    const input = toCreateTokenRequest({
      ...emptyTokenFormValues(expiration),
      expirationMode: 'custom',
      name: 'Website form',
    });

    expect(input.expiresAt).toBe(new Date(expiration).toISOString());
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequestSchema, {
        onExcessProperty: 'error',
      })(input),
    ).resolves.toEqual(input);
  });

  test('retains omission for empty custom mapper values; the UI requires a date', () => {
    const input = toCreateTokenRequest({
      ...emptyTokenFormValues(''),
      expirationMode: 'custom',
      name: 'Website form',
    });

    expect(input.expiresAt).toBeUndefined();
    expect(JSON.parse(JSON.stringify(input))).toEqual({
      name: 'Website form',
      type: 'api',
    });
  });

  test('keeps the selected browser type', async () => {
    const input = toCreateTokenRequest({
      ...emptyTokenFormValues(future()),
      name: 'Browser form',
      type: 'browser',
    });

    expect(input.type).toBe('browser');
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequestSchema, {
        onExcessProperty: 'error',
      })(input),
    ).resolves.toEqual(input);
  });
});
