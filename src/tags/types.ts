/**
 * Tag domain types used by the workbench. They are aliases of the Effect
 * Schema contract in `src/domain/schemas.ts`, so the wire contract stays the
 * single source of truth; this module only adds UI-only helpers.
 */
import {
  type CatalogTagView,
  type TagColor,
  type TagScopeView,
  type TagView,
} from '@/domain/schemas';

export type CatalogTag = CatalogTagView;
export type Tag = TagView;
export type TagScope = TagScopeView;

export const tagColors: Array<{ label: string; value: TagColor }> = [
  { label: 'Sage', value: 'teal' },
  { label: 'Blue', value: 'blue' },
  { label: 'Lavender', value: 'violet' },
  { label: 'Taupe', value: 'amber' },
];

/**
 * Applies the exclusivity policy to a chip-input draft: a scoped choice
 * replaces any current selection in the same scope, standalone tags
 * accumulate. The server enforces the same rule atomically; this keeps the
 * draft honest before the save round-trip.
 */
export const addTags = (
  current: readonly string[],
  added: readonly string[],
  catalogTags: readonly Tag[],
): string[] => {
  let next = [...current];
  for (const id of added) {
    const tag = catalogTags.find((item) => item.id === id);
    if (!tag) {
      continue;
    }

    if (tag.scopeId) {
      const siblings = new Set(
        catalogTags
          .filter((item) => item.scopeId === tag.scopeId)
          .map((item) => item.id),
      );
      next = next.filter((item) => !siblings.has(item));
    }

    if (!next.includes(id)) {
      next.push(id);
    }
  }

  return next;
};

/**
 * Resolves assigned ids to tags in catalog order, ignoring unknown ids.
 */
export const tagsForIds = (
  ids: readonly string[],
  catalogTags: readonly Tag[],
): Tag[] => catalogTags.filter((tag) => ids.includes(tag.id));

export { type TagCatalog, type TagColor } from '@/domain/schemas';
