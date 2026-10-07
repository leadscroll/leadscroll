import { addTags, initialTags, tagLabel } from '@/design-preview/tags/model';
import { describe, expect, it } from 'vitest';

describe('tag proposal exclusivity', () => {
  it('replaces only tags in the same exclusive prefix', () => {
    expect(
      addTags(
        ['fall-considering', 'spring-considering', 'vip'],
        ['fall-closed'],
        initialTags,
      ),
    ).toEqual(['spring-considering', 'vip', 'fall-closed']);
  });
  it('keeps independent tags and avoids duplicates', () => {
    expect(addTags(['vip'], ['scholarship', 'vip'], initialTags)).toEqual([
      'vip',
      'scholarship',
    ]);
  });
  it('treats every scope as exclusive, including interest', () => {
    expect(
      addTags(['interest-art', 'vip'], ['interest-music'], initialTags),
    ).toEqual(['vip', 'interest-music']);
  });
  it('does not mutate prior assignments or accept unknown tags', () => {
    const before = ['fall-considering'];
    expect(addTags(before, ['missing', 'fall-closed'], initialTags)).toEqual([
      'fall-closed',
    ]);
    expect(before).toEqual(['fall-considering']);
  });
  it('renames a prefix without changing tag identity', () => {
    const groups = initialTags.groups.map((group) => ({
      ...group,
      prefix: 'autumn26',
    }));
    expect(
      tagLabel(
        {
          color: 'violet',
          groupId: 'fall',
          id: 'fall-considering',
          name: 'considering',
        },
        groups,
      ),
    ).toBe('autumn26:considering');
    expect(initialTags.assignments['preview-lead-1']).toContain(
      'fall-considering',
    );
  });
});
