import { fieldTitle } from './customFields';

export type LeadCsvColumn = {
  header: string;
  value: (row: LeadCsvRow) => unknown;
};

/**
 * Spreadsheet CSV export for leads.
 *
 * One row per lead. The fixed core columns are always present; custom fields
 * are appended as extra columns derived from the union of keys in the exported
 * result. That union is why the column planner is shared by the export service
 * and its tests instead of being hard-coded in the route.
 */
export type LeadCsvRow = {
  createdAt: string;
  customFields: Readonly<Record<string, unknown>>;
  email: null | string;
  estimatedValue: null | number;
  firstName: null | string;
  id: string;
  lastName: null | string;
  origin: null | string;
  source: string;
  updatedAt: string;
};

export const CSV_BOM = '\uFEFF';
export const CSV_LINE_END = '\r\n';

const coreColumns: readonly LeadCsvColumn[] = [
  { header: 'id', value: (row) => row.id },
  { header: 'First name', value: (row) => row.firstName },
  { header: 'Last name', value: (row) => row.lastName },
  { header: 'Email', value: (row) => row.email },
  { header: 'Source', value: (row) => row.source },
  { header: 'Estimated value', value: (row) => row.estimatedValue },
  { header: 'Origin', value: (row) => row.origin },
  { header: 'Created at', value: (row) => row.createdAt },
  { header: 'Updated at', value: (row) => row.updatedAt },
];

const normalizedHeader = (header: string): string => header.toLowerCase();

const compareKeys = (left: string, right: string): number => {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) {
    return -1;
  }

  if (normalizedLeft > normalizedRight) {
    return 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Plans the final header order: core columns first, then custom fields sorted
 * by a stable, case-insensitive key order. A custom column whose display title
 * collides with a core or earlier custom header gets the raw key appended, so
 * `projectType` and `project_type` stay distinguishable.
 */
export const planLeadCsvColumns = (
  customKeys: Iterable<string>,
): LeadCsvColumn[] => {
  const columns = [...coreColumns];
  const usedHeaders = new Set(
    columns.map((column) => normalizedHeader(column.header)),
  );

  for (const key of [...customKeys].toSorted(compareKeys)) {
    const title = fieldTitle(key) || key;
    let header = title;
    if (usedHeaders.has(normalizedHeader(header))) {
      header = `${title} (${key})`;
    }

    // Raw keys are unique, so this loop only guards against pathological keys
    // that still normalize to an existing header (for example case variants).
    let suffix = 2;
    while (usedHeaders.has(normalizedHeader(header))) {
      header = `${title} (${key}) ${String(suffix)}`;
      suffix += 1;
    }

    usedHeaders.add(normalizedHeader(header));
    columns.push({
      header,
      value: (row) =>
        Object.hasOwn(row.customFields, key)
          ? row.customFields[key]
          : undefined,
    });
  }

  return columns;
};

// Spreadsheet applications treat a leading =, +, -, @, tab, or carriage return
// as a formula. Intake data is caller-controlled, so string cells are prefixed
// with an apostrophe, which spreadsheets render as plain text.
const FORMULA_PREFIX = /^[=+\-@\t\r]/u;

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return FORMULA_PREFIX.test(value) ? `'${value}` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return JSON.stringify(value) ?? '';
};

const needsQuoting = /[",\r\n]|^\s|\s$/u;

export const encodeCsvCell = (value: unknown): string => {
  const text = cellText(value);
  return needsQuoting.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const encodeLeadCsvHeader = (columns: LeadCsvColumn[]): string =>
  `${CSV_BOM}${columns
    .map((column) => encodeCsvCell(column.header))
    .join(',')}${CSV_LINE_END}`;

export const encodeLeadCsvRow = (
  row: LeadCsvRow,
  columns: LeadCsvColumn[],
): string =>
  `${columns
    .map((column) => encodeCsvCell(column.value(row)))
    .join(',')}${CSV_LINE_END}`;
