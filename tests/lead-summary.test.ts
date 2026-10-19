import { formatLeadSummary } from '@/notifications/lead-summary';
import { describe, expect, test } from 'vitest';

describe('lead email summary', () => {
  test('uses the first name, last initial, and source', () => {
    const summary = formatLeadSummary({
      firstName: 'Sam',
      lastName: 'Kovacs',
      source: 'pricing_form',
    });
    expect(summary).toBe('Sam K. · pricing_form');
    expect(summary).not.toContain('Kovacs');
  });

  test('handles missing name parts and collapses whitespace', () => {
    expect(
      formatLeadSummary({
        firstName: null,
        lastName: null,
        source: 'website',
      }),
    ).toBe('website');
    expect(
      formatLeadSummary({
        firstName: '  Sam ',
        lastName: null,
        source: ' website ',
      }),
    ).toBe('Sam · website');
    expect(
      formatLeadSummary({
        firstName: null,
        lastName: 'Kovacs',
        source: ' website ',
      }),
    ).toBe('K. · website');
  });

  test('uses the first Unicode character and truncates long values', () => {
    expect(
      formatLeadSummary({
        firstName: 'Ольга',
        lastName: 'Петрова',
        source: 'website',
      }),
    ).toBe('Ольга П. · website');

    const summary = formatLeadSummary({
      firstName: 'Sam',
      lastName: 'Kovacs',
      source: 'x'.repeat(200),
    });
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThan(120);
  });
});
