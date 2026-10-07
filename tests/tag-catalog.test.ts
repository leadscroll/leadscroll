import {
  parseTagName,
  removeCatalogTag,
  renameCatalogScope,
  saveCatalogTag,
} from '@/design-preview/tags/catalog';
import {
  addTags,
  initialTags,
  type TagState,
} from '@/design-preview/tags/model';
import { describe, expect, it } from 'vitest';

const save = (state: TagState, name: string, id?: string): TagState => {
  const result = saveCatalogTag(state, name, id);
  if ('error' in result) {
    throw new Error(result.error);
  }

  return result.state;
};

describe('inferred tag scopes', () => {
  it('creates a missing scope and reuses it for the next value', () => {
    const first = save(initialTags, ' summer27 : considering ');
    const second = save(first, 'summer27:closed');
    const scope = second.groups.find((group) => group.prefix === 'summer27');
    expect(second.groups).toHaveLength(initialTags.groups.length + 1);
    expect(
      second.tags
        .filter((tag) => tag.groupId === scope?.id)
        .map((tag) => tag.name),
    ).toEqual(['considering', 'closed']);
    expect(scope).not.toHaveProperty('exclusive');
    expect(
      initialTags.groups.some((group) => group.prefix === 'summer27'),
    ).toBe(false);
  });
  it('adds an independent tag without adding a scope', () => {
    const next = save(initialTags, 'partner');
    expect(next.tags.at(-1)).toMatchObject({ groupId: '', name: 'partner' });
    expect(next.groups).toEqual(initialTags.groups);
  });
  it('renames a typo while preserving ID and assignments', () => {
    const next = save(initialTags, 'fall26:interested', 'fall-considering');
    expect(
      next.tags.find((tag) => tag.id === 'fall-considering'),
    ).toMatchObject({ groupId: 'fall', name: 'interested' });
    expect(next.assignments).toEqual(initialTags.assignments);
  });
  it('rejects duplicate names instead of implicitly merging', () => {
    expect(
      saveCatalogTag(initialTags, ' FALL26:CLOSED ', 'fall-considering'),
    ).toHaveProperty('error');
    expect(saveCatalogTag(initialTags, 'VIP')).toHaveProperty('error');
  });
  it('deletes only one tag and preserves its sibling tags and leads', () => {
    const next = removeCatalogTag(initialTags, 'fall-considering');
    expect(next.assignments['preview-lead-1']).toEqual([
      'source-website',
      'vip',
    ]);
    expect(Object.keys(next.assignments)).toEqual(
      Object.keys(initialTags.assignments),
    );
    expect(next.tags.some((tag) => tag.id === 'fall-closed')).toBe(true);
    expect(next.groups.some((group) => group.id === 'fall')).toBe(true);
  });
  it('removes an inferred scope when its final tag is deleted', () => {
    const next = removeCatalogTag(
      removeCatalogTag(initialTags, 'interest-art'),
      'interest-music',
    );
    expect(next.groups.some((group) => group.id === 'interest')).toBe(false);
    expect(next.groups.some((group) => group.id === 'fall')).toBe(true);
  });
  it('rejects a move that would put two same-scope tags on a lead', () => {
    expect(saveCatalogTag(initialTags, 'fall26:vip', 'vip')).toHaveProperty(
      'error',
    );
    expect(initialTags.assignments['preview-lead-1']).toContain('vip');
  });
  it('renames a scope while retaining relationships and rejects collisions', () => {
    const result = renameCatalogScope(initialTags, 'fall', 'autumn26');
    expect(result).toHaveProperty(
      'state.groups',
      expect.arrayContaining([
        expect.objectContaining({ id: 'fall', prefix: 'autumn26' }),
      ]),
    );
    expect(result).toHaveProperty('state.assignments', initialTags.assignments);
    expect(renameCatalogScope(initialTags, 'fall', 'source')).toHaveProperty(
      'error',
    );
  });
  it.each(['', ' ', ':value', 'scope:', 'a:b:c'])(
    'rejects malformed name %s',
    (input) => {
      expect(parseTagName(input)).toHaveProperty('error');
    },
  );
  it('enforces every scope without a per-scope setting', () => {
    expect(
      addTags(
        ['interest-art', 'fall-considering', 'vip'],
        ['interest-music'],
        initialTags,
      ),
    ).toEqual(['fall-considering', 'vip', 'interest-music']);
  });
});
