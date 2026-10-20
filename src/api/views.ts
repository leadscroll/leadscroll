/**
 * Wire-view mappers for HTTP API success schemas.
 *
 * Repositories return `Date` objects and internal records. The API schemas
 * describe ISO-8601 strings, so handlers map at the boundary instead of
 * relying on JSON.stringify's implicit Date conversion.
 */

import { type TagViewRecord } from '@/db/repositories/tags';
import { type LeadRecord } from '@/db/repository';
import {
  type LeadActivity,
  type LeadView,
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
