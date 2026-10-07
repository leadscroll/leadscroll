export type CatalogTag = Tag & { leadCount: number };

export type Tag = {
  color: TagColor;
  createdAt: string;
  id: string;
  label: string;
  name: string;
  scopeId: null | string;
  updatedAt: string;
};

export type TagCatalog = {
  scopes: TagScope[];
  tags: CatalogTag[];
};

/**
 * Tag domain types shared by the workbench. These mirror the wire contracts in
 * `src/domain/schemas.ts`: validation lives there, this module only carries the
 * decoded shapes into React.
 */
export type TagColor = 'amber' | 'blue' | 'teal' | 'violet';

export type TagScope = {
  color: TagColor;
  createdAt: string;
  id: string;
  prefix: string;
  updatedAt: string;
};

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
