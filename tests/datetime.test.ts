import {
  localDateTimeToIso,
  localTimezoneLabel,
  localZone,
  toLocalInputValue,
  wallClockIssue,
  wallClockToIso,
} from '@/lib/datetime';
import { describe, expect, test } from 'vitest';

const CHICAGO = 'America/Chicago';
// A fixed "now" keeps the validation assertions deterministic; without it the
// overlap fixture would turn into a failing past date after 2026-11-01.
const NOW = Temporal.Instant.from('2026-01-01T00:00:00Z');

describe('wall-clock conversion', () => {
  test('resolves the zone offset for the selected date', () => {
    expect(wallClockToIso('2026-12-31T15:07', CHICAGO)).toBe(
      '2026-12-31T21:07:00.000Z',
    );
    expect(wallClockToIso('2026-07-04T12:00', CHICAGO)).toBe(
      '2026-07-04T17:00:00.000Z',
    );
  });

  test('an empty input maps to the server default', () => {
    expect(wallClockToIso('', CHICAGO)).toBeUndefined();
    expect(localDateTimeToIso('')).toBeUndefined();
  });

  test('a malformed value maps to undefined', () => {
    expect(wallClockToIso('not-a-date', CHICAGO)).toBeUndefined();
  });

  test('renders an instant back to the same wall clock', () => {
    expect(toLocalInputValue(new Date('2026-12-31T21:07:00Z'), CHICAGO)).toBe(
      '2026-12-31T15:07',
    );
  });

  test('round-trips through a zone', () => {
    const wall = toLocalInputValue(new Date('2026-07-04T17:00:00Z'), CHICAGO);
    expect(wallClockToIso(wall, CHICAGO)).toBe('2026-07-04T17:00:00.000Z');
  });
});

describe('daylight-saving policy', () => {
  test('rejects a wall clock inside the spring-forward gap', () => {
    expect(wallClockIssue('2026-03-08T02:30', CHICAGO, NOW)).toBe(
      'That local time does not exist on this date (daylight saving).',
    );
    // Validation blocks submission; the raw conversion keeps the platform's
    // compatible resolution (02:30 CST does not exist, so it becomes 03:30 CDT).
    expect(wallClockToIso('2026-03-08T02:30', CHICAGO)).toBe(
      '2026-03-08T08:30:00.000Z',
    );
  });

  test('resolves a fall-back overlap to the earlier occurrence', () => {
    expect(wallClockToIso('2026-11-01T01:30', CHICAGO)).toBe(
      '2026-11-01T06:30:00.000Z',
    );
    expect(wallClockIssue('2026-11-01T01:30', CHICAGO, NOW)).toBe(true);
  });

  test('labels the offset of the selected date, not today', () => {
    expect(localTimezoneLabel('2026-12-31T15:07', CHICAGO)).toBe(
      'America/Chicago (UTC-06:00)',
    );
    expect(localTimezoneLabel('2026-07-04T12:00', CHICAGO)).toBe(
      'America/Chicago (UTC-05:00)',
    );
  });
});

describe('future validation', () => {
  test('rejects the past and accepts the future', () => {
    expect(wallClockIssue('2000-01-01T00:00', CHICAGO, NOW)).toBe(
      'Expiration must be in the future.',
    );
    expect(wallClockIssue('2999-01-01T00:00', CHICAGO, NOW)).toBe(true);
  });

  test('an empty input is valid (server default)', () => {
    expect(wallClockIssue('', CHICAGO)).toBe(true);
  });
});

describe('local zone resolution', () => {
  test('uses the runtime IANA zone', () => {
    expect(localZone()).toBeTypeOf('string');
    expect(wallClockToIso('2999-01-01T00:00', localZone())).toMatch(/Z$/u);
  });
});
