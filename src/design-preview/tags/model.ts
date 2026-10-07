export type Tag = {
  color: TagColor;
  groupId: string;
  id: string;
  name: string;
};
export type TagColor = 'amber' | 'blue' | 'teal' | 'violet';
export type TagGroup = {
  color: TagColor;
  id: string;
  prefix: string;
};

export type TagState = {
  assignments: Record<string, string[]>;
  groups: TagGroup[];
  tags: Tag[];
};

export const tagLabel = (tag: Tag, groups: TagGroup[]): string => {
  const group = groups.find((item) => item.id === tag.groupId);
  return group ? `${group.prefix}:${tag.name}` : tag.name;
};

// Preview policy only. A production implementation must enforce this atomically
// in the API as well; the UI alone is not an exclusivity boundary.
export const addTags = (
  current: string[],
  added: string[],
  state: TagState,
): string[] => {
  let next = [...current];
  for (const id of added) {
    const tag = state.tags.find((item) => item.id === id);
    if (!tag) {
      continue;
    }

    const group = state.groups.find((item) => item.id === tag.groupId);
    if (group) {
      const siblings = new Set(
        state.tags
          .filter((item) => item.groupId === group.id)
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

export const initialTags: TagState = {
  assignments: {
    'preview-lead-1': ['source-website', 'fall-considering', 'vip'],
    'preview-lead-2': [
      'source-referral',
      'fall-enrolled',
      'spring-considering',
    ],
    'preview-lead-3': ['source-website', 'fall-considering', 'scholarship'],
    'preview-lead-4': ['source-event', 'fall-closed'],
    'preview-lead-5': ['source-website', 'fall-enrolled', 'vip'],
    'preview-lead-6': ['source-referral', 'spring-considering'],
    'preview-lead-7': [
      'source-website',
      'fall-considering',
      'spring-considering',
      'vip',
    ],
    'preview-lead-8': ['source-website', 'fall-closed'],
    'preview-lead-9': ['source-event', 'spring-waitlist', 'scholarship'],
    'preview-lead-10': ['source-referral'],
  },
  groups: [
    { color: 'teal', id: 'source', prefix: 'source' },
    { color: 'amber', id: 'interest', prefix: 'interest' },
    { color: 'violet', id: 'fall', prefix: 'fall26' },
    { color: 'blue', id: 'spring', prefix: 'spring27' },
  ],
  tags: [
    { color: 'teal', groupId: 'source', id: 'source-website', name: 'website' },
    {
      color: 'teal',
      groupId: 'source',
      id: 'source-referral',
      name: 'referral',
    },
    { color: 'teal', groupId: 'source', id: 'source-event', name: 'event' },
    { color: 'teal', groupId: 'source', id: 'source-manual', name: 'manual' },
    { color: 'amber', groupId: 'interest', id: 'interest-art', name: 'art' },
    {
      color: 'amber',
      groupId: 'interest',
      id: 'interest-music',
      name: 'music',
    },
    {
      color: 'violet',
      groupId: 'fall',
      id: 'fall-considering',
      name: 'considering',
    },
    { color: 'violet', groupId: 'fall', id: 'fall-enrolled', name: 'enrolled' },
    { color: 'violet', groupId: 'fall', id: 'fall-closed', name: 'closed' },
    {
      color: 'blue',
      groupId: 'spring',
      id: 'spring-considering',
      name: 'considering',
    },
    {
      color: 'blue',
      groupId: 'spring',
      id: 'spring-waitlist',
      name: 'waitlist',
    },
    { color: 'amber', groupId: '', id: 'vip', name: 'vip' },
    { color: 'teal', groupId: '', id: 'scholarship', name: 'scholarship' },
  ],
};
