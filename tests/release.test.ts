import { releaseLabel } from '@/lib/release';
import { describe, expect, test } from 'vitest';

describe('release label', () => {
  test('formats the build instant in the viewer zone', () => {
    expect(releaseLabel('2026-10-05T18:39:00Z', 'America/Chicago')).toBe(
      'v2026-10-05',
    );
    // 02:30Z is still the previous day in Chicago (UTC-5 in October).
    expect(releaseLabel('2026-10-06T02:30:00Z', 'America/Chicago')).toBe(
      'v2026-10-05',
    );
    expect(releaseLabel('2026-10-06T02:30:00Z', 'UTC')).toBe('v2026-10-06');
  });
});
