import { RecordIdSchema } from './common';
import { NonEmptyStringSchema } from './internal';
import { Schema } from 'effect';

// Tags. `prefix:value` tags share a scope and are exclusive per lead; plain
// tags are standalone. Colors are a closed palette shared by the UI.
export const TAG_COLORS = ['teal', 'blue', 'violet', 'amber'] as const;
export const TagColorSchema = Schema.Literals(TAG_COLORS);
export type TagColor = Schema.Schema.Type<typeof TagColorSchema>;

// A full tag name is `prefix:value` or a plain value: at most 30 characters
// for the scope, 40 for the value, plus one delimiter. Parsing (rather than
// this bound) enforces the single delimiter.
export const TagNameSchema = NonEmptyStringSchema.check(Schema.isMaxLength(71));
export const TagScopePrefixSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(30),
);

export const TagScopeViewSchema = Schema.Struct({
  color: TagColorSchema,
  createdAt: Schema.String,
  id: RecordIdSchema,
  prefix: Schema.String,
  updatedAt: Schema.String,
});
export type TagScopeView = Schema.Schema.Type<typeof TagScopeViewSchema>;

export const TagViewSchema = Schema.Struct({
  color: TagColorSchema,
  createdAt: Schema.String,
  id: RecordIdSchema,
  label: Schema.String,
  name: Schema.String,
  scopeId: Schema.NullOr(RecordIdSchema),
  updatedAt: Schema.String,
});
export type TagView = Schema.Schema.Type<typeof TagViewSchema>;

// Catalog rows additionally report how many active accessible leads use them.
export const CatalogTagViewSchema = Schema.Struct({
  ...TagViewSchema.fields,
  leadCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
});
export type CatalogTagView = Schema.Schema.Type<typeof CatalogTagViewSchema>;

export const TagCatalogSchema = Schema.Struct({
  scopes: Schema.Array(TagScopeViewSchema),
  tags: Schema.Array(CatalogTagViewSchema),
});
export type TagCatalog = Schema.Schema.Type<typeof TagCatalogSchema>;

export const CreateTagRequestSchema = Schema.Struct({ name: TagNameSchema });
export type CreateTagRequest = Schema.Schema.Type<
  typeof CreateTagRequestSchema
>;

export const UpdateTagRequestSchema = Schema.Struct({
  color: Schema.optional(TagColorSchema),
  name: Schema.optional(TagNameSchema),
});
export type UpdateTagRequest = Schema.Schema.Type<
  typeof UpdateTagRequestSchema
>;

export const UpdateTagScopeRequestSchema = Schema.Struct({
  color: Schema.optional(TagColorSchema),
  prefix: Schema.optional(TagScopePrefixSchema),
});
export type UpdateTagScopeRequest = Schema.Schema.Type<
  typeof UpdateTagScopeRequestSchema
>;

export const SetLeadTagsRequestSchema = Schema.Struct({
  tagIds: Schema.Array(RecordIdSchema).check(Schema.isMaxLength(100)),
});
export type SetLeadTagsRequest = Schema.Schema.Type<
  typeof SetLeadTagsRequestSchema
>;

export const BulkTagRequestSchema = Schema.Struct({
  ids: Schema.Array(RecordIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  mode: Schema.Literals(['add', 'remove']),
  tagIds: Schema.Array(RecordIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export type BulkTagRequest = Schema.Schema.Type<typeof BulkTagRequestSchema>;
