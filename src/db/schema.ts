import { user } from './auth-schema';
import { type AuditChange, type InstallationConfig } from '@/domain/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// App-owned timestamps store Unix milliseconds (the Better Auth convention)
// and read back as Date values. API responses serialize them to ISO-8601.
const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const leads = sqliteTable(
  'leads',
  {
    createdAt: timestampMs('created_at').notNull(),
    customFields: text('custom_fields', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    deletedAt: timestampMs('deleted_at'),
    email: text('email'),
    estimatedValue: integer('estimated_value'),
    firstName: text('first_name'),
    id: text('id').primaryKey(),
    lastName: text('last_name'),
    origin: text('origin'),
    rawPayload: text('raw_payload', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    skippedFields: text('skipped_fields', { mode: 'json' }).$type<
      Array<{ name: string; reason: 'sensitive' | 'unmarked' }>
    >(),
    source: text('source').notNull(),
    tokenId: text('token_id'),
    updatedAt: timestampMs('updated_at').notNull(),
  },
  (table) => [
    index('leads_email_idx').on(table.email),
    // The flat leads list orders by createdAt, so it gets its own index.
    index('leads_created_idx').on(table.createdAt),
  ],
);

// Tag scopes are inferred from a `prefix:value` tag name and own one shared
// color. The prefix is unique within the installation; a scope's identity (its
// id) survives renaming. An empty scope is pruned when its last tag is deleted.
export const tagScopes = sqliteTable(
  'tag_scopes',
  {
    color: text('color').notNull(),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    prefix: text('prefix').notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
  },
  (table) => [uniqueIndex('tag_scopes_prefix_unique').on(table.prefix)],
);

// A stable tag id stores the normalized value. Scoped tags point at their
// scope and inherit its color; standalone tags carry their own color.
export const tags = sqliteTable(
  'tags',
  {
    color: text('color'),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    scopeId: text('scope_id').references(() => tagScopes.id),
    updatedAt: timestampMs('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('tags_scope_name_unique').on(table.scopeId, table.name),
    // SQLite treats NULL scope ids as distinct, so standalone-name uniqueness
    // needs its own partial index.
    uniqueIndex('tags_standalone_name_unique')
      .on(table.name)
      .where(sql`${table.scopeId} IS NULL`),
    index('tags_scope_idx').on(table.scopeId),
  ],
);

// Lead <-> tag assignment. `scope_id` is denormalized onto the join so a
// partial unique index enforces the global exclusivity rule at the database
// level: at most one tag per scope on a lead, even under concurrent writes.
export const leadTags = sqliteTable(
  'lead_tags',
  {
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id),
    scopeId: text('scope_id').references(() => tagScopes.id),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (table) => [
    uniqueIndex('lead_tags_lead_tag_unique').on(table.leadId, table.tagId),
    uniqueIndex('lead_tags_lead_scope_unique')
      .on(table.leadId, table.scopeId)
      .where(sql`${table.scopeId} IS NOT NULL`),
    index('lead_tags_lead_idx').on(table.leadId),
    index('lead_tags_tag_idx').on(table.tagId),
  ],
);

export const activities = sqliteTable(
  'activities',
  {
    actorEmail: text('actor_email'),
    body: text('body').notNull(),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [
    index('activities_lead_created_idx').on(table.leadId, table.createdAt),
  ],
);

export const apiTokens = sqliteTable('api_tokens', {
  createdAt: timestampMs('created_at').notNull(),
  expiresAt: timestampMs('expires_at'),
  id: text('id').primaryKey(),
  lastUsedAt: timestampMs('last_used_at'),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  revokedAt: timestampMs('revoked_at'),
  scope: text('scope').notNull().default('intake:write'),
  // Browser tokens are safe to embed, so the value is stored and copyable.
  // API tokens are secrets: only the hash is stored.
  token: text('token').unique(),
  tokenHash: text('token_hash').unique(),
  type: text('type', { enum: ['api', 'browser'] })
    .notNull()
    .default('api'),
});

// Single-use staff invitations. The token itself is never stored; only its
// hash plus a short prefix for display. Timestamps are Unix milliseconds
// (same convention as api_tokens).
export const staffInvites = sqliteTable('staff_invites', {
  createdAt: timestampMs('created_at').notNull(),
  expiresAt: timestampMs('expires_at').notNull(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  revokedAt: timestampMs('revoked_at'),
  tokenHash: text('token_hash').notNull().unique(),
  usedAt: timestampMs('used_at'),
  usedByUserId: text('used_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
});

// One-row bootstrap invite state. The check keeps the table a singleton;
// the baseline migration inserts the seed row (INSERT OR IGNORE, so reruns
// never refresh or reopen it).
export const bootstrapState = sqliteTable(
  'bootstrap_state',
  {
    consumedAt: timestampMs('consumed_at'),
    createdAt: timestampMs('created_at').notNull(),
    expiresAt: timestampMs('expires_at').notNull(),
    id: text('id').primaryKey(),
  },
  () => [check('bootstrap_state_default_only', sql`id = 'default'`)],
);

// Durable single-use ledger for registration redemption (baseline schema).
// The UNIQUE claim_key is the race guard: two concurrent redemptions of the
// same grant cannot both insert, and the loser's batch rolls back in full.
// The baseline grant-guard trigger re-validates grant eligibility
// inside the redemption batch, so a grant that is revoked, used, or expires
// between the pre-check and the batch still fails atomically. The claim row
// deliberately survives user deletion (ON DELETE SET NULL): a deleted
// bootstrap user must not reopen the bootstrap grant.
export const registrationClaims = sqliteTable('registration_claims', {
  claimKey: text('claim_key').notNull().unique(),
  createdAt: timestampMs('created_at').notNull(),
  grantKind: text('grant_kind').notNull(),
  grantRef: text('grant_ref').notNull(),
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
});

// Better Auth tables (user, session, account, verification). Generated by the
// Better Auth CLI into ./auth-schema.ts; see src/auth/cli.ts.
export * from './auth-schema';

// Better Auth's database-backed rate limiter (rateLimit.storage: 'database' in
// src/auth/index.ts) keeps counters in D1, so the limit is shared across
// Worker isolates instead of per-isolate memory. Columns follow the Better Auth
// rateLimit model: key, count, lastRequest.
export const rateLimit = sqliteTable('rate_limit', {
  count: integer('count').notNull(),
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  lastRequest: integer('last_request').notNull(),
});

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    createdAt: timestampMs('created_at').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash'),
    responseJson: text('response_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [uniqueIndex('idempotency_key_unique').on(table.key)],
);

// --- New-lead email notifications ------------------------------------------

// Personal opt-in, off by default for every existing and future account. The
// feature is only available when the installation's email settings enable a
// provider; the preference itself is always writable so a staff member can
// opt in while email is being configured. One installation has one staff team,
// so the preference is keyed by the user alone.
export const notificationPreferences = sqliteTable('notification_preferences', {
  newLeadEmail: integer('new_lead_email', { mode: 'boolean' })
    .notNull()
    .default(false),
  updatedAt: timestampMs('updated_at').notNull(),
  userId: text('user_id')
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

// Installation-wide singleton configuration document. The JSON column is
// typed with the domain schema for compile-time safety, while the
// authoritative runtime validation (version and excess-property rejection)
// happens in src/domain/schemas.ts on every read and before every write.
// The fixed `id = 1` keeps the table a singleton without inventing a tenant
// identifier. `updated_at` is the internal compare-and-swap token: every write
// stores a strictly increasing Unix-millisecond value (including test-state
// updates), separate from the user-visible `revision` inside the JSON so a
// test completion cannot invalidate a settings draft or overwrite a
// concurrent configuration change. Who changed the configuration is the
// generic audit_log's job; this row carries only the concurrency token.
export const installationConfig = sqliteTable(
  'installation_config',
  {
    documentJson: text('document_json', { mode: 'json' })
      .$type<InstallationConfig>()
      .notNull(),
    id: integer('id').primaryKey(),
    updatedAt: timestampMs('updated_at').notNull(),
    // Random token written by every successful save. Audit statements in the
    // same batch are gated on it, so a compare-and-swap loser whose UPDATE
    // matched no rows cannot slip its audit rows into the winner's write.
    writeToken: text('write_token'),
  },
  (table) => [check('installation_config_singleton', sql`${table.id} = 1`)],
);

// Generic, append-only who-changed-what log. The `changes_json` column is
// typed with the bounded audit schema for compile-time safety; the
// authoritative runtime validation/redaction happens in
// src/domain/schemas.ts on every write and read. There is no user-facing
// audit editor in this release. Configuration changes are the initial
// producer; the lifecycle is independent of the configuration document.
export const auditLog = sqliteTable(
  'audit_log',
  {
    action: text('action').notNull(),
    actorUserId: text('actor_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    changesJson: text('changes_json', { mode: 'json' })
      .$type<readonly AuditChange[]>()
      .notNull(),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    resourceId: text('resource_id'),
    resourceType: text('resource_type').notNull(),
  },
  (table) => [index('audit_log_created_idx').on(table.createdAt, table.id)],
);
