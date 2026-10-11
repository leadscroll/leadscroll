import { user } from './auth-schema';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// App-owned timestamps store Unix milliseconds (the Better Auth convention)
// and read back as Date values. API responses serialize them to ISO-8601.
const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const workspaces = sqliteTable('workspaces', {
  createdAt: timestampMs('created_at').notNull(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  updatedAt: timestampMs('updated_at').notNull(),
});

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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('leads_email_idx').on(table.workspaceId, table.email),
    // The flat leads list orders by createdAt, so it gets its own index.
    index('leads_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

// Tag scopes are inferred from a `prefix:value` tag name and own one shared
// color. The prefix is unique per workspace; a scope's identity (its id)
// survives renaming. An empty scope is pruned when its last tag is deleted.
export const tagScopes = sqliteTable(
  'tag_scopes',
  {
    color: text('color').notNull(),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    prefix: text('prefix').notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('tag_scopes_workspace_prefix_unique').on(
      table.workspaceId,
      table.prefix,
    ),
  ],
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('tags_workspace_scope_name_unique').on(
      table.workspaceId,
      table.scopeId,
      table.name,
    ),
    // SQLite treats NULL scope ids as distinct, so standalone-name uniqueness
    // needs its own partial index.
    uniqueIndex('tags_workspace_standalone_name_unique')
      .on(table.workspaceId, table.name)
      .where(sql`${table.scopeId} IS NULL`),
    index('tags_workspace_scope_idx').on(table.workspaceId, table.scopeId),
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('activities_lead_created_idx').on(table.leadId, table.createdAt),
  ],
);

export const apiTokens = sqliteTable(
  'api_tokens',
  {
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [index('api_tokens_workspace_idx').on(table.workspaceId)],
);

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
// the seed row is inserted by migration 0004 (INSERT OR IGNORE, so reruns
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

// Durable single-use ledger for registration redemption (migration 0005).
// The UNIQUE claim_key is the race guard: two concurrent redemptions of the
// same grant cannot both insert, and the loser's batch rolls back in full.
// The grant-guard trigger (migration 0005) re-validates grant eligibility
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
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('idempotency_workspace_key_unique').on(
      table.workspaceId,
      table.key,
    ),
  ],
);

// --- New-lead email notifications ------------------------------------------

// Personal opt-in, off by default for every existing and future account. The
// feature is only available when the installation's email settings enable a
// provider; the preference itself is always writable so a staff member can
// opt in while email is being configured.
export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    newLeadEmail: integer('new_lead_email', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: timestampMs('updated_at').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

// Durable per-recipient delivery ledger. One row per
// (workspace, event, recipient, template version); the unique index is the
// duplicate guard for intake replays and concurrent creation. Provider
// credentials are never stored here: `provider` and `config_revision` pin the
// account configuration, and `frozen_envelope_json` holds only the rendered
// minimal message frozen at the first attempt.
export const NOTIFICATION_STATUSES = [
  'pending',
  'claimed',
  'sending',
  'accepted',
  'retry',
  'skipped',
  'failed',
  'unknown',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_PROVIDERS = ['cloudflare', 'resend'] as const;
export type NotificationProvider = (typeof NOTIFICATION_PROVIDERS)[number];

export const notificationOutbox = sqliteTable(
  'notification_outbox',
  {
    acceptedAt: timestampMs('accepted_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    configRevision: integer('config_revision'),
    createdAt: timestampMs('created_at').notNull(),
    deliveryKey: text('delivery_key'),
    eventKey: text('event_key').notNull(),
    eventKind: text('event_kind').notNull().default('lead.created'),
    firstAttemptAt: timestampMs('first_attempt_at'),
    frozenEnvelopeJson: text('frozen_envelope_json'),
    id: text('id').primaryKey(),
    idempotencyDeadline: timestampMs('idempotency_deadline'),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id),
    leaseExpiresAt: timestampMs('lease_expires_at'),
    leaseToken: text('lease_token'),
    nextAttemptAt: timestampMs('next_attempt_at').notNull(),
    payloadHash: text('payload_hash'),
    provider: text('provider', { enum: NOTIFICATION_PROVIDERS }),
    providerMessageId: text('provider_message_id'),
    reasonCode: text('reason_code'),
    recipientEmail: text('recipient_email').notNull(),
    // Set to NULL when the staff account is deleted; the accepted audit row
    // and the frozen address survive. Deletion also skips pending work.
    recipientUserId: text('recipient_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: NOTIFICATION_STATUSES })
      .notNull()
      .default('pending'),
    templateVersion: integer('template_version').notNull().default(1),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('notification_outbox_event_recipient_unique').on(
      table.workspaceId,
      table.eventKey,
      table.recipientUserId,
      table.templateVersion,
    ),
    // Due-work scan: pending/retry rows ordered by their next attempt.
    index('notification_outbox_due_idx').on(
      table.status,
      table.nextAttemptAt,
      table.id,
    ),
    // Lease recovery scan (claimed/sending rows whose lease expired).
    index('notification_outbox_lease_idx').on(table.leaseExpiresAt),
    // Per-recipient self-service history, newest first.
    index('notification_outbox_history_idx').on(
      table.workspaceId,
      table.recipientUserId,
      table.createdAt,
    ),
  ],
);

// Bounded operational state per workspace: proves the scheduler runs and
// records the last safe configuration error without deriving health from
// successful messages alone.
export const notificationDispatchState = sqliteTable(
  'notification_dispatch_state',
  {
    configErrorAt: timestampMs('config_error_at'),
    configErrorCode: text('config_error_code'),
    configErrorRevision: integer('config_error_revision'),
    lastSuccessAt: timestampMs('last_success_at'),
    lastTickAt: timestampMs('last_tick_at').notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id').primaryKey(),
  },
  () => [],
);

// Explicit administrator test messages. The request id is durable so replays
// and concurrent attempts cannot emit a second message; the frozen payload
// lets a Resend ambiguous outcome retry the exact same keyed request inside
// its idempotency window.
export const NOTIFICATION_TEST_STATUSES = [
  'sending',
  'accepted',
  'rejected',
  'ambiguous',
  'configuration_error',
] as const;
export type NotificationTestStatus =
  (typeof NOTIFICATION_TEST_STATUSES)[number];

export const notificationTestAttempts = sqliteTable(
  'notification_test_attempts',
  {
    completedAt: timestampMs('completed_at'),
    configRevision: integer('config_revision').notNull(),
    createdAt: timestampMs('created_at').notNull(),
    deliveryKey: text('delivery_key'),
    frozenEnvelopeJson: text('frozen_envelope_json'),
    id: text('id').primaryKey(),
    provider: text('provider', { enum: NOTIFICATION_PROVIDERS }),
    providerMessageId: text('provider_message_id'),
    reasonCode: text('reason_code'),
    status: text('status', { enum: NOTIFICATION_TEST_STATUSES })
      .notNull()
      .default('sending'),
    updatedAt: timestampMs('updated_at').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('notification_test_attempts_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

// Installation-level email configuration singleton per workspace. `revision`
// is server-generated and compare-and-swap guarded; a paused configuration
// error is tied to the revision that produced it, so any settings change
// resumes attempts without an automatic test.
export const EMAIL_SETTINGS_PROVIDERS = [
  'disabled',
  'cloudflare',
  'resend',
] as const;
export type EmailSettingsProvider = (typeof EMAIL_SETTINGS_PROVIDERS)[number];

export const emailSettings = sqliteTable(
  'email_settings',
  {
    canonicalOrigin: text('canonical_origin'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    fromEmail: text('from_email'),
    fromName: text('from_name'),
    pausedAt: timestampMs('paused_at'),
    pausedReasonCode: text('paused_reason_code'),
    pausedRevision: integer('paused_revision'),
    provider: text('provider', { enum: EMAIL_SETTINGS_PROVIDERS })
      .notNull()
      .default('disabled'),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestampMs('updated_at').notNull(),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    workspaceId: text('workspace_id').primaryKey(),
    // Random token written by every successful save. Credential and audit
    // statements in the same batch are gated on it, so a compare-and-swap loser
    // whose UPDATE matched no rows cannot slip its writes into a concurrent
    // winner's revision.
    writeToken: text('write_token'),
  },
  () => [],
);

// Encrypted provider credentials. The plaintext value is never stored; the
// AES-256-GCM envelope binds the workspace, provider, and key version through
// authenticated additional data. Removing the row is the only delete path.
export const emailCredentials = sqliteTable(
  'email_credentials',
  {
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    nonce: text('nonce').notNull(),
    provider: text('provider', { enum: ['resend'] }).notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.provider] })],
);

// Narrow installation-level capability. Presence of a row grants
// manageEmailSettings. Nothing else is editable here: there is no general
// roles editor in this release.
export const emailSettingsPermissions = sqliteTable(
  'email_settings_permissions',
  {
    grantedAt: timestampMs('granted_at').notNull(),
    grantedByUserId: text('granted_by_user_id'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

// Redacted audit trail: actor, action, revision, safe outcome, and time. Key
// material, message bodies, and recipient addresses are never recorded here.
export const emailSettingsAudit = sqliteTable(
  'email_settings_audit',
  {
    action: text('action').notNull(),
    actorUserId: text('actor_user_id'),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    reasonCode: text('reason_code'),
    revision: integer('revision').notNull(),
    testOutcome: text('test_outcome'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('email_settings_audit_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);
