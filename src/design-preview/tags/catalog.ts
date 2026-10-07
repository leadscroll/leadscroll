import { type TagColor, tagLabel, type TagState } from './model';

export const tagColors: Array<{ label: string; value: TagColor }> = [
  { label: 'Sage', value: 'teal' },
  { label: 'Blue', value: 'blue' },
  { label: 'Lavender', value: 'violet' },
  { label: 'Taupe', value: 'amber' },
];

type CatalogResult = { error: string } | { state: TagState };
type ParsedTagName = { error: string } | { name: string; prefix: string };

export const parseTagName = (input: string): ParsedTagName => {
  const parts = input
    .trim()
    .toLowerCase()
    .split(':')
    .map((part) => part.trim());
  if (!parts[0] || parts.some((part) => !part) || parts.length > 2) {
    return { error: 'Enter a tag name or scope:value.' } as const;
  }

  const prefix = parts.length === 2 ? parts[0] : '';
  const name = parts.at(-1) ?? '';
  if (prefix.length > 30 || name.length > 40) {
    return {
      error: 'Use up to 30 characters for the scope and 40 for the tag.',
    } as const;
  }

  return { name, prefix };
};

const pruneScopes = (state: TagState): TagState => ({
  ...state,
  groups: state.groups.filter((group) =>
    state.tags.some((tag) => tag.groupId === group.id),
  ),
});

export const saveCatalogTag = (
  state: TagState,
  input: string,
  id?: string,
): CatalogResult => {
  const parsed = parseTagName(input);
  if ('error' in parsed) {
    return { error: parsed.error };
  }

  const { name, prefix } = parsed;
  const fullName = prefix ? `${prefix}:${name}` : name;
  if (
    state.tags.some(
      (tag) => tag.id !== id && tagLabel(tag, state.groups) === fullName,
    )
  ) {
    return { error: 'That tag already exists. Choose another name.' };
  }

  const previous = state.tags.find((tag) => tag.id === id);
  if (id && !previous) {
    return { error: 'This tag no longer exists.' };
  }

  let group = prefix
    ? state.groups.find((item) => item.prefix === prefix)
    : undefined;
  if (previous && group && previous.groupId !== group.id) {
    const targetGroupId = group.id;
    const siblings = new Set(
      state.tags
        .filter((tag) => tag.groupId === targetGroupId)
        .map((tag) => tag.id),
    );
    if (
      Object.values(state.assignments).some(
        (ids) =>
          ids.includes(previous.id) && ids.some((tagId) => siblings.has(tagId)),
      )
    ) {
      return {
        error: `Some leads already have a ${prefix}: tag. Resolve those conflicts before moving this tag.`,
      };
    }
  }

  let groups = state.groups;
  if (prefix && !group) {
    group = {
      color: tagColors[state.groups.length % tagColors.length].value,
      id: crypto.randomUUID(),
      prefix,
    };
    groups = [...groups, group];
  }

  const previousColor =
    state.groups.find((item) => item.id === previous?.groupId)?.color ??
    previous?.color;
  const nextTag = {
    color: group?.color ?? previousColor ?? 'teal',
    groupId: group?.id ?? '',
    id: id ?? crypto.randomUUID(),
    name,
  };
  return {
    state: pruneScopes({
      ...state,
      groups,
      tags: previous
        ? state.tags.map((item) => (item.id === id ? nextTag : item))
        : [...state.tags, nextTag],
    }),
  };
};

export const removeCatalogTag = (state: TagState, id: string): TagState =>
  pruneScopes({
    ...state,
    assignments: Object.fromEntries(
      Object.entries(state.assignments).map(([leadId, ids]) => [
        leadId,
        ids.filter((tagId) => tagId !== id),
      ]),
    ),
    tags: state.tags.filter((tag) => tag.id !== id),
  });

export const renameCatalogScope = (
  state: TagState,
  id: string,
  input: string,
): CatalogResult => {
  const prefix = input.trim().toLowerCase();
  if (!prefix || prefix.includes(':') || prefix.length > 30) {
    return { error: 'Enter a scope of 1–30 characters without a colon.' };
  }

  if (
    state.groups.some((group) => group.id !== id && group.prefix === prefix)
  ) {
    return { error: 'That scope already exists. Choose another name.' };
  }

  return {
    state: {
      ...state,
      groups: state.groups.map((group) =>
        group.id === id ? { ...group, prefix } : group,
      ),
    },
  };
};
