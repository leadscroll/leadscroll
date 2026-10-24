export {
  bulkTag,
  type BulkTagOutcome,
  setLeadTags,
  type SetLeadTagsOutcome,
} from './assignments';
export { listTagCatalog } from './catalog';
export {
  createTag,
  deleteTag,
  type DeleteTagOutcome,
  type TagMutationOutcome,
  type TagScopeMutationOutcome,
  updateTag,
  updateTagScope,
} from './mutations';
export {
  guardActiveLeadsStatement,
  leadTagStatements,
  resolveTagPlan,
  type TagPlan,
  tagPlanStatements,
} from './planning';
export {
  type CatalogTagRecord,
  parseTagsJson,
  type TagScopeRecord,
  type TagViewRecord,
} from './shared';
