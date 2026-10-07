import { deriveTagSpecs, parseTagName } from '@/domain/tags';
import { addTags, type Tag, tagsForIds } from '@/tags/types';
import { describe, expect, test } from 'vitest';

const catalog: Tag[] = [
  {
    color: 'violet',
    createdAt: '',
    id: 'fall-considering',
    label: 'fall26:considering',
    name: 'considering',
    scopeId: 'fall',
    updatedAt: '',
  },
  {
    color: 'violet',
    createdAt: '',
    id: 'fall-closed',
    label: 'fall26:closed',
    name: 'closed',
    scopeId: 'fall',
    updatedAt: '',
  },
  {
    color: 'teal',
    createdAt: '',
    id: 'vip',
    label: 'vip',
    name: 'vip',
    scopeId: null,
    updatedAt: '',
  },
];

describe('tag name canonicalization', () => {
  test('parses a plain value and a scoped pair', () => {
    expect(parseTagName(' VIP ')).toEqual({ name: 'vip', prefix: '' });
    expect(parseTagName(' Fall26 : Considering ')).toEqual({
      name: 'considering',
      prefix: 'fall26',
    });
  });

  test.each(['', ' ', ':value', 'scope:', 'a:b:c'])(
    'rejects malformed name %s',
    (input) => {
      expect(parseTagName(input)).toHaveProperty('error');
    },
  );

  test('bounds the prefix and value lengths', () => {
    expect(parseTagName(`${'p'.repeat(31)}:value`)).toHaveProperty('error');
    expect(parseTagName(`scope:${'v'.repeat(41)}`)).toHaveProperty('error');
  });
});

describe('intake tag specs', () => {
  test('derives a lossless source tag when no explicit source is present', () => {
    expect(deriveTagSpecs({ source: 'Website_Form' })).toEqual({
      specs: [{ name: 'website_form', prefix: 'source' }],
    });
  });

  test('lets an explicit source tag win over the derived source', () => {
    expect(
      deriveTagSpecs({ source: 'Website_Form', tags: ['source:referral'] }),
    ).toEqual({ specs: [{ name: 'referral', prefix: 'source' }] });
  });

  test('never truncates an over-length legacy source value', () => {
    const long = 'x'.repeat(80);
    expect(deriveTagSpecs({ source: long })).toEqual({
      specs: [{ name: long, prefix: 'source' }],
    });
  });

  test('reports a malformed explicit tag instead of dropping it', () => {
    expect(deriveTagSpecs({ source: 'website', tags: ['a:b:c'] })).toEqual({
      error: 'Enter a tag name or scope:value.',
    });
  });
});

describe('chip draft exclusivity', () => {
  test('a scoped choice replaces its sibling and keeps standalone tags', () => {
    expect(
      addTags(['fall-considering', 'vip'], ['fall-closed'], catalog),
    ).toEqual(['vip', 'fall-closed']);
  });

  test('standalone tags accumulate without dropping each other', () => {
    expect(addTags(['vip'], ['vip'], catalog)).toEqual(['vip']);
  });

  test('resolves ids in catalog order and ignores unknown ids', () => {
    expect(tagsForIds(['missing', 'vip'], catalog)).toEqual([catalog[2]]);
  });
});
