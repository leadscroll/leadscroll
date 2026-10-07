/**
 * Tag-name parsing shared by the API and the UI.
 *
 * A tag is either a plain value (`vip`) or a scoped `prefix:value` pair. A
 * scoped pair is globally exclusive per lead: a lead may hold at most one tag
 * per prefix. Ordinary names are bounded to 30 characters for the prefix and
 * 40 for the value with exactly one delimiter. Historical `leads.source`
 * values are mapped separately with the lossless path in the migration and
 * repository, so a legacy value is never rejected, dropped, or truncated here.
 */
export type ParsedTagName =
  { error: string } | { name: string; prefix: string };

/**
 * A resolved tag identity used for persistence planning.
 */
export type TagSpec = { name: string; prefix: string };

export const TAG_PREFIX_MAX = 30;
export const TAG_VALUE_MAX = 40;

/**
 * Canonical full-name parser for ordinary new tags. Trims, lowercases, and
 * allows exactly one `:` delimiter.
 */
export const parseTagName = (input: string): ParsedTagName => {
  const parts = input
    .trim()
    .toLowerCase()
    .split(':')
    .map((part) => part.trim());
  if (!parts[0] || parts.some((part) => !part) || parts.length > 2) {
    return { error: 'Enter a tag name or scope:value.' };
  }

  const prefix = parts.length === 2 ? parts[0] : '';
  const name = parts.at(-1) ?? '';
  if (prefix.length > TAG_PREFIX_MAX || name.length > TAG_VALUE_MAX) {
    return {
      error: `Use up to ${String(TAG_PREFIX_MAX)} characters for the scope and ${String(TAG_VALUE_MAX)} for the tag.`,
    };
  }

  return { name, prefix };
};

/**
 * Deterministic normalization for a source classification. It intentionally
 * mirrors the SQLite `lower(trim(source))` used by the 0003 backfill so a
 * legacy source maps to the same `source:*` tag before and after migration:
 * - SQLite `trim(x)` removes only ASCII space (0x20), not tabs/newlines, so
 *   this uses a space-only trim rather than JavaScript's Unicode `trim()`.
 * - SQLite `lower(x)` folds ASCII A-Z only, so this uses an ASCII fold rather
 *   than JavaScript's Unicode `toLowerCase()`.
 * The value keeps its full length and any colons; nothing is truncated.
 */
const SQLITE_SPACE_TRIM = /^ +| +$/gu;
const ASCII_UPPER = /[A-Z]/gu;

export const normalizeSourceTag = (source: string): string =>
  source
    .replaceAll(SQLITE_SPACE_TRIM, '')
    .replaceAll(ASCII_UPPER, (char) => char.toLowerCase());

export const tagLabel = (name: string, prefix: null | string): string =>
  prefix ? `${prefix}:${name}` : name;

/**
 * Builds the tag specs for a write from an explicit `tags` list plus the
 * legacy `source` classification. Explicit `source:*` tags take precedence
 * over the derived source. Ordinary names go through the canonical parser;
 * malformed input reports an error instead of being dropped. The derived
 * source tag is lossless (never truncated) so legacy values survive.
 */
export const deriveTagSpecs = (input: {
  source?: null | string;
  tags?: readonly string[];
}): { error: string } | { specs: TagSpec[] } => {
  const specs: TagSpec[] = [];
  for (const raw of input.tags ?? []) {
    const parsed = parseTagName(raw);
    if ('error' in parsed) {
      return { error: parsed.error };
    }

    specs.push({ name: parsed.name, prefix: parsed.prefix });
  }

  const hasExplicitSource = specs.some((spec) => spec.prefix === 'source');
  const source = input.source;
  if (
    !hasExplicitSource &&
    source !== null &&
    source !== undefined &&
    source.trim() !== ''
  ) {
    // Pass the raw value: `normalizeSourceTag` performs the exact
    // SQLite-matching trim/lower, so this stays byte-identical to the backfill.
    specs.push({ name: normalizeSourceTag(source), prefix: 'source' });
  }

  return { specs };
};
