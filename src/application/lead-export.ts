import { persist } from './errors';
import {
  type Env,
  type LeadExportRow,
  type LeadFilterOptions,
  listLeadCustomFieldKeys,
  listLeadExportPage,
} from '@/db/repository';
import {
  encodeLeadCsvHeader,
  encodeLeadCsvRow,
  type LeadCsvColumn,
  type LeadCsvRow,
  planLeadCsvColumns,
} from '@/domain/leadCsv';
import { decodeKeysetCursor, type Keyset } from '@/domain/pagination';
import { Effect } from 'effect';

// D1 returns a bounded page; the export streams through as many pages as the
// filtered set needs. The chunk size only controls how often the Worker yields
// a buffer to the response stream.
const EXPORT_PAGE_SIZE = 500;
const CHUNK_ROWS = 250;

const toCsvRow = (row: LeadExportRow): LeadCsvRow => ({
  createdAt: row.createdAt.toISOString(),
  customFields: row.customFields,
  email: row.email,
  estimatedValue: row.estimatedValue,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  origin: row.origin,
  source: row.source,
  updatedAt: row.updatedAt.toISOString(),
});

const leadExportRows = async function* (
  environment: Env,
  filters: LeadFilterOptions,
): AsyncGenerator<LeadExportRow> {
  let cursor: Keyset | null = null;
  for (;;) {
    const page = await listLeadExportPage(environment, {
      ...filters,
      cursor,
      limit: EXPORT_PAGE_SIZE,
    });
    yield* page.rows;
    if (page.nextCursor === null) {
      return;
    }

    cursor = decodeKeysetCursor(page.nextCursor);
    if (cursor === null) {
      throw new Error('The export cursor could not be decoded.');
    }
  }
};

export const leadCsvFileName = (now: Date = new Date()): string =>
  `leadscroll-leads-${now.toISOString().slice(0, 10)}.csv`;

/**
 * Emits a valid CSV document over the filtered live-lead set. The header is
 * yielded first because the column union was already resolved by the caller.
 */
export const leadCsvChunks = async function* (
  environment: Env,
  filters: LeadFilterOptions,
  columns: LeadCsvColumn[],
): AsyncGenerator<string> {
  yield encodeLeadCsvHeader(columns);

  let chunk = '';
  let rowsInChunk = 0;
  for await (const row of leadExportRows(environment, filters)) {
    chunk += encodeLeadCsvRow(toCsvRow(row), columns);
    rowsInChunk += 1;
    if (rowsInChunk >= CHUNK_ROWS) {
      yield chunk;
      chunk = '';
      rowsInChunk = 0;
    }
  }

  if (chunk !== '') {
    yield chunk;
  }
};

/**
 * Resolves the dynamic headers before the response starts, then returns the
 * row stream. Custom-field discovery is a normal Effect so a bad query becomes
 * the shared JSON error envelope instead of a truncated download.
 */
export const prepareLeadCsvExport = (
  environment: Env,
  filters: LeadFilterOptions,
) =>
  Effect.gen(function* () {
    const customKeys = yield* persist(() =>
      listLeadCustomFieldKeys(environment, filters),
    );
    const columns = planLeadCsvColumns(customKeys);
    return {
      chunks: leadCsvChunks(environment, filters, columns),
      filename: leadCsvFileName(),
    };
  });
