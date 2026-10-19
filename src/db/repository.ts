/**
 * Public persistence barrel.
 *
 * Domain modules live in ./repositories; callers keep importing from this
 * stable surface so the split does not change application or test imports.
 */

export type { Env } from './env';

export {
  type AccountSessionRecord,
  availableStaffInviteGrant,
  checkStaffInviteAvailability,
  createApiToken,
  createStaffInvite,
  getStaffAccountByEmail,
  type InviteRecord,
  isBootstrapGrantAvailable,
  listAccountSessions,
  listApiTokens,
  listStaffAccounts,
  listStaffInvites,
  revokeAccountSession,
  revokeApiToken,
  revokeOtherAccountSessions,
  revokeStaffInvite,
  setStaffAccountDisabled,
  type SetStaffDisabledOutcome,
  type StaffAccountRecord,
} from './repositories/access';

export {
  getIntakeKey,
  type IntakePersistenceOutcome,
  isBrowserIntakeToken,
  isIntakeToken,
  outcomeForStoredIntakeKey,
  type StoredIntakeKey,
} from './repositories/intake';

export {
  createLead,
  createLeadActivity,
  createLeadAtomically,
  getLead,
  type LeadPage,
  type LeadPageOptions,
  type LeadRecord,
  listLeadActivities,
  listLeads,
  softDeleteLeads,
  updateLead,
} from './repositories/leads';

export {
  appendAuditLog,
  AuditLogDecodeError,
  type AuditLogPage,
  getNotificationPreference,
  InstallationConfigDecodeError,
  type InstallationConfigRow,
  type InstallationConfigWriteInput,
  type LeadCreatedRecipient,
  listAuditLog,
  listLeadCreatedRecipients,
  type NotificationPreferenceRecord,
  readInstallationConfig,
  upsertNotificationPreference,
  writeInstallationConfig,
} from './repositories/notifications';

export {
  bulkTag,
  type BulkTagOutcome,
  type CatalogTagRecord,
  createTag,
  deleteTag,
  type DeleteTagOutcome,
  listTagCatalog,
  setLeadTags,
  type SetLeadTagsOutcome,
  type TagMutationOutcome,
  type TagScopeMutationOutcome,
  type TagScopeRecord,
  type TagViewRecord,
  updateTag,
  updateTagScope,
} from './repositories/tags';
