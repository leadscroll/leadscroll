import {
  CSV_BOM,
  encodeCsvCell,
  encodeLeadCsvHeader,
  encodeLeadCsvRow,
  type LeadCsvRow,
  planLeadCsvColumns,
} from '@/domain/leadCsv';
import { describe, expect, test } from 'vitest';

const row = (overrides: Partial<LeadCsvRow> = {}): LeadCsvRow => ({
  createdAt: '2026-11-12T08:00:00.000Z',
  customFields: {},
  email: 'ada@example.test',
  estimatedValue: 2_500,
  firstName: 'Ada',
  id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  lastName: 'Lovelace',
  origin: 'https://example.test/form',
  source: 'website',
  updatedAt: '2026-11-12T09:00:00.000Z',
  ...overrides,
});

const headers = (keys: string[]): string[] =>
  planLeadCsvColumns(keys).map((column) => column.header);

describe('lead CSV columns', () => {
  test('keeps a stable core and excludes list-only fields such as tags', () => {
    expect(headers([])).toEqual([
      'id',
      'First name',
      'Last name',
      'Email',
      'Source',
      'Estimated value',
      'Origin',
      'Created at',
      'Updated at',
    ]);
    expect(headers([])).not.toContain('Tags');
  });

  test('appends the sorted union of custom fields', () => {
    expect(headers(['projectType', 'company', 'budget'])).toEqual([
      'id',
      'First name',
      'Last name',
      'Email',
      'Source',
      'Estimated value',
      'Origin',
      'Created at',
      'Updated at',
      'Budget',
      'Company',
      'Project Type',
    ]);
  });

  test('keeps colliding titles distinguishable with their raw keys', () => {
    const columns = planLeadCsvColumns([
      'email',
      'projectType',
      'project_type',
    ]);
    expect(columns.slice(9).map((column) => column.header)).toEqual([
      'Email (email)',
      'Project Type',
      'Project Type (projectType)',
    ]);
  });
});

describe('lead CSV encoding', () => {
  test('writes a BOM, quoted headers, and CRLF', () => {
    const columns = planLeadCsvColumns(['company']);
    expect(encodeLeadCsvHeader(columns)).toBe(
      `${CSV_BOM}id,First name,Last name,Email,Source,Estimated value,Origin,Created at,Updated at,Company\r\n`,
    );
  });

  test('quotes commas, quotes, newlines, and surrounding whitespace', () => {
    expect(encodeCsvCell('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(encodeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(encodeCsvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(encodeCsvCell(' padded ')).toBe('" padded "');
    expect(encodeCsvCell('plain')).toBe('plain');
  });

  test('neutralizes spreadsheet formulas in strings but not numbers', () => {
    expect(encodeCsvCell('=1+1')).toBe("'=1+1");
    expect(encodeCsvCell('+15551234567')).toBe("'+15551234567");
    expect(encodeCsvCell('-5')).toBe("'-5");
    expect(encodeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(encodeCsvCell(-5)).toBe('-5');
  });

  test('serializes nulls, booleans, and nested custom values losslessly', () => {
    expect(encodeCsvCell(null)).toBe('');
    expect(encodeCsvCell(undefined)).toBe('');
    expect(encodeCsvCell(false)).toBe('false');
    expect(encodeCsvCell({ plan: 'pro' })).toBe('"{""plan"":""pro""}"');
    expect(encodeCsvCell(['a', 'b'])).toBe('"[""a"",""b""]"');
  });

  test('fills missing custom fields and keeps values in column order', () => {
    const columns = planLeadCsvColumns(['company', 'budget']);
    const line = encodeLeadCsvRow(
      row({
        customFields: { budget: 5_000, company: 'Navy' },
      }),
      columns,
    );
    expect(line).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FB0,Ada,Lovelace,ada@example.test,website,2500,https://example.test/form,2026-11-12T08:00:00.000Z,2026-11-12T09:00:00.000Z,5000,Navy\r\n',
    );
    expect(line).not.toContain('tags');
  });
});
