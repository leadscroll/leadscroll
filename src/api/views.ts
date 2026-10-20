/**
 * Wire-view mappers for HTTP API success schemas.
 *
 * Repositories return `Date` objects and internal records. The API schemas
 * describe ISO-8601 strings, so handlers map at the boundary instead of
 * relying on JSON.stringify's implicit Date conversion.
 */

import {
  type CatalogTagRecord,
  type TagScopeRecord,
  type TagViewRecord,
} from '@/db/repositories/tags';
import { type LeadRecord } from '@/db/repository';
import {
  type CatalogTagView,
  type LeadActivity,
  type LeadView,
  type TagCatalog,
  type TagScopeView,
  type TagView,
} from '@/domain/schemas';

export const toTagView = (tag: TagViewRecord): TagView => ({
  color: tag.color,
  createdAt: tag.createdAt.toISOString(),
  id: tag.id,
  label: tag.label,
  name: tag.name,
  scopeId: tag.scopeId,
  updatedAt: tag.updatedAt.toISOString(),
});

export const toLeadView = (lead: LeadRecord): LeadView => ({
  createdAt: lead.createdAt.toISOString(),
  customFields: lead.customFields,
  deletedAt: lead.deletedAt === null ? null : lead.deletedAt.toISOString(),
  duplicateCount: lead.duplicateCount,
  email: lead.email,
  estimatedValue: lead.estimatedValue,
  firstName: lead.firstName,
  id: lead.id,
  lastName: lead.lastName,
  origin: lead.origin,
  ...(lead.rawPayload === undefined ? {} : { rawPayload: lead.rawPayload }),
  skippedFields: lead.skippedFields,
  source: lead.source,
  tags: lead.tags.map(toTagView),
  tokenId: lead.tokenId,
  ...(lead.tokenName === undefined ? {} : { tokenName: lead.tokenName }),
  ...(lead.tokenType === undefined ? {} : { tokenType: lead.tokenType }),
  updatedAt: lead.updatedAt.toISOString(),
});

export const toTagScopeView = (scope: TagScopeRecord): TagScopeView => ({
  color: scope.color,
  createdAt: scope.createdAt.toISOString(),
  id: scope.id,
  prefix: scope.prefix,
  updatedAt: scope.updatedAt.toISOString(),
});

export const toCatalogTagView = (tag: CatalogTagRecord): CatalogTagView => ({
  ...toTagView(tag),
  leadCount: tag.leadCount,
});

export const toTagCatalog = (catalog: {
  scopes: TagScopeRecord[];
  tags: CatalogTagRecord[];
}): TagCatalog => ({
  scopes: catalog.scopes.map(toTagScopeView),
  tags: catalog.tags.map(toCatalogTagView),
});

export const toLeadActivity = (activity: {
  actorEmail: null | string;
  body: string;
  createdAt: Date;
  id: string;
  kind: string;
}): LeadActivity => ({
  actorEmail: activity.actorEmail,
  body: activity.body,
  createdAt: activity.createdAt.toISOString(),
  id: activity.id,
  kind: activity.kind,
});

type ApiTokenRecordView = {
  createdAt: Date;
  expiresAt: Date | null;
  id: string;
  lastUsedAt?: Date | null;
  name: string;
  prefix: string;
  revokedAt: Date | null;
  scope: string;
  token: null | string;
  type: 'api' | 'browser';
};

export const toApiTokenView = (record: ApiTokenRecordView) => ({
  createdAt: record.createdAt.toISOString(),
  expiresAt: record.expiresAt?.toISOString() ?? null,
  id: record.id,
  lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  name: record.name,
  prefix: record.prefix,
  revokedAt: record.revokedAt?.toISOString() ?? null,
  scope: record.scope,
  token: record.token,
  type: record.type,
});

type InviteRecordView = {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  name: string;
  prefix: string;
  revokedAt: Date | null;
  usedAt: Date | null;
};

export const toInviteView = (record: InviteRecordView) => ({
  createdAt: record.createdAt.toISOString(),
  expiresAt: record.expiresAt.toISOString(),
  id: record.id,
  name: record.name,
  prefix: record.prefix,
  revokedAt: record.revokedAt?.toISOString() ?? null,
  usedAt: record.usedAt?.toISOString() ?? null,
});

type StaffAccountViewRecord = {
  disabledAt: Date | null;
  email: string;
  id: string;
  name: string;
};

export const toStaffAccountView = (record: StaffAccountViewRecord) => ({
  disabledAt: record.disabledAt?.toISOString() ?? null,
  email: record.email,
  id: record.id,
  name: record.name,
});
