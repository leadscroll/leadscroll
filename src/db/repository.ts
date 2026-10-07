import {
  createClient,
  type Database,
  executeAtomically,
  prepare,
  type Statement,
} from './driver';
import {
  activities,
  apiTokens,
  bootstrapState,
  idempotencyKeys,
  leads,
  leadTags,
  session,
  staffInvites,
  tags,
  tagScopes,
  user,
} from './schema';
import { type RegistrationGrant } from '@/auth/registration-repository';
import { type IntakeResponse } from '@/domain/intake';
import { encodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  type CreateLeadRequest,
  type IntakeRequest,
  normalizeEmail,
  type SkippedField,
  type TagColor,
  type UpdateLeadRequest,
} from '@/domain/schemas';
import { tagLabel, type TagSpec } from '@/domain/tags';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

export type Env = {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  // Optional canonical origin override. When absent or blank, authentication
  // uses the incoming request URL's origin; production requires HTTPS.
  BETTER_AUTH_URL?: string;
  DB: Database;
  // Development/test-only identity bypass. Never honored in production.
  DEV_ADMIN_EMAIL?: string;
  ENVIRONMENT: 'development' | 'production' | 'test';
  // Invite token required to create a staff account (X-Setup-Token header on
  // POST /api/auth/sign-up/email). Unset or empty rejects every sign-up.
  SETUP_TOKEN?: string;
};

export const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const now = (): Date => new Date();
const id = (): string => {
  let timestamp = Date.now();
  let result = '';
  for (let index = 0; index < 10; index += 1) {
    result = ULID_ALPHABET[timestamp % 32] + result;
    timestamp = Math.floor(timestamp / 32);
  }

  const random = crypto.getRandomValues(new Uint8Array(16));
  return (
    result + Array.from(random, (value) => ULID_ALPHABET[value % 32]).join('')
  );
};

const getDatabase = (environment: Env) => createClient(environment.DB);

export type LeadPage = {
  leads: LeadRecord[];
  nextCursor: null | string;
};

export type LeadPageOptions = {
  cursor?: Keyset | null;
  limit: number;
  query?: string;
  tagId?: string;
  tagScopeId?: string;
};

export type LeadRecord = {
  createdAt: Date;
  customFields: Record<string, unknown>;
  deletedAt: Date | null;
  duplicateCount: number;
  email: null | string;
  estimatedValue: null | number;
  firstName: null | string;
  id: string;
  lastName: null | string;
  origin: null | string;
  rawPayload?: null | Record<string, unknown>;
  skippedFields: null | SkippedField[];
  source: string;
  tags: TagViewRecord[];
  tokenId: null | string;
  tokenName?: null | string;
  tokenType?: 'api' | 'browser' | null;
  updatedAt: Date;
};

/**
 * Literal, case-insensitive substring match on the email or first/last name.
 * `instr` is used instead of LIKE because D1 caps LIKE/GLOB patterns at 50
 * bytes — an ordinary search string exceeds that once wrapped — and because
 * it removes wildcard escaping entirely, so a literal backslash, `%`, or `_`
 * matches itself.
 */
const leadSearchPredicate = (query: string) => {
  const needle = sql`lower(${query})`;
  return sql`(instr(lower(${leads.email}), ${needle}) > 0 OR instr(lower(${leads.firstName}), ${needle}) > 0 OR instr(lower(${leads.lastName}), ${needle}) > 0)`;
};

/**
 * Count of live leads that share the row's normalized email, including the row
 * itself. Computed in the page/detail query with the leads_email_idx index, so
 * list responses need no second round trip and bind no variable-length email
 * list (D1 caps bound parameters per statement). The outer columns are
 * qualified by hand because Drizzle renders a single-table FROM without a table
 * prefix in a select projection. `toLead` subtracts the row itself to produce
 * the duplicate hint.
 */
const duplicateCountExpression = sql<number>`(
  SELECT count(*) FROM leads AS duplicate
  WHERE duplicate.workspace_id = leads.workspace_id
    AND duplicate.deleted_at IS NULL
    AND duplicate.email IS NOT NULL
    AND duplicate.email = leads.email
)`;

/**
 * Assigned tags as a JSON array in the SAME list/detail SELECT, so rendering a
 * page never fans out into a per-lead lookup and the page query keeps one
 * statement with a constant number of bound parameters. `COALESCE` keeps the
 * no-tags case as `[]` instead of NULL. Order is applied after parsing.
 */
const tagsJsonExpression = sql<string>`COALESCE((
  SELECT json_group_array(json_object(
    'color', tag.color,
    'createdAt', tag.created_at,
    'id', tag.id,
    'name', tag.name,
    'scopeColor', scope.color,
    'scopeId', tag.scope_id,
    'scopePrefix', scope.prefix,
    'updatedAt', tag.updated_at
  ))
  FROM lead_tags AS assignment
  JOIN tags AS tag ON tag.id = assignment.tag_id
  LEFT JOIN tag_scopes AS scope ON scope.id = tag.scope_id
  WHERE assignment.lead_id = leads.id
), '[]')`;

type LeadListRow = Omit<
  typeof leads.$inferSelect,
  'rawPayload' | 'workspaceId'
>;

const toLead = (
  row: LeadListRow & { duplicateCount: number },
  detail: {
    rawPayload?: null | Record<string, unknown>;
    tags?: TagViewRecord[];
    tokenName?: null | string;
    tokenType?: 'api' | 'browser' | null;
  } = {},
): LeadRecord => ({
  createdAt: row.createdAt,
  customFields: row.customFields,
  deletedAt: row.deletedAt,
  duplicateCount: row.email ? Math.max(0, Number(row.duplicateCount) - 1) : 0,
  email: row.email,
  estimatedValue: row.estimatedValue,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  origin: row.origin,
  skippedFields: row.skippedFields ?? null,
  source: row.source,
  tags: detail.tags ?? [],
  tokenId: row.tokenId,
  updatedAt: row.updatedAt,
  ...(detail.rawPayload === undefined ? {} : { rawPayload: detail.rawPayload }),
  ...(detail.tokenName === undefined ? {} : { tokenName: detail.tokenName }),
  ...(detail.tokenType === undefined ? {} : { tokenType: detail.tokenType }),
});

export type CatalogTagRecord = TagViewRecord & { leadCount: number };

export type TagScopeRecord = {
  color: TagColor;
  createdAt: Date;
  id: string;
  prefix: string;
  updatedAt: Date;
};

export type TagViewRecord = {
  color: TagColor;
  createdAt: Date;
  id: string;
  label: string;
  name: string;
  scopeId: null | string;
  updatedAt: Date;
};

const TAG_PALETTE = [
  'teal',
  'blue',
  'violet',
  'amber',
] as const satisfies readonly TagColor[];

const nextTagColor = (count: number): TagColor =>
  TAG_PALETTE[count % TAG_PALETTE.length] ?? 'teal';

const asTagColor = (value: null | string): TagColor =>
  TAG_PALETTE.includes(value as TagColor) ? (value as TagColor) : 'teal';

type TagRowWithScope = {
  color: null | string;
  createdAt: Date;
  id: string;
  name: string;
  scopeColor: null | string;
  scopeId: null | string;
  scopePrefix: null | string;
  updatedAt: Date;
};

const toTagViewRecord = (row: TagRowWithScope): TagViewRecord => ({
  color: asTagColor(row.scopeColor ?? row.color),
  createdAt: row.createdAt,
  id: row.id,
  label: tagLabel(row.name, row.scopePrefix),
  name: row.name,
  scopeId: row.scopeId,
  updatedAt: row.updatedAt,
});

const parseTagsJson = (value: null | string): TagViewRecord[] => {
  if (!value) {
    return [];
  }

  try {
    const rows = JSON.parse(value) as Array<
      Omit<TagRowWithScope, 'createdAt' | 'updatedAt'> & {
        createdAt: number;
        updatedAt: number;
      }
    >;
    return rows
      .map((row) =>
        toTagViewRecord({
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        }),
      )
      .toSorted((left, right) => left.label.localeCompare(right.label));
  } catch {
    return [];
  }
};

/**
 * Loads the assigned tag views for a bounded set of lead ids in one query, so
 * a list page or detail read never fans out into a per-row lookup.
 */
const tagViewsForLeads = async (
  database: ReturnType<typeof getDatabase>,
  leadIds: readonly string[],
): Promise<Map<string, TagViewRecord[]>> => {
  const result = new Map<string, TagViewRecord[]>();
  if (leadIds.length === 0) {
    return result;
  }

  const rows = await database
    .select({
      color: tags.color,
      createdAt: tags.createdAt,
      id: tags.id,
      leadId: leadTags.leadId,
      name: tags.name,
      scopeColor: tagScopes.color,
      scopeId: tags.scopeId,
      scopePrefix: tagScopes.prefix,
      updatedAt: tags.updatedAt,
    })
    .from(leadTags)
    .innerJoin(tags, eq(tags.id, leadTags.tagId))
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId))
    .where(
      and(
        eq(leadTags.workspaceId, DEFAULT_WORKSPACE_ID),
        sql`${leadTags.leadId} IN (SELECT value FROM json_each(${JSON.stringify(leadIds)}))`,
      ),
    )
    .orderBy(asc(tags.name));

  for (const row of rows) {
    const list = result.get(row.leadId) ?? [];
    list.push(toTagViewRecord(row));
    result.set(row.leadId, list);
  }

  return result;
};

/**
 * Keyset (seek) pagination over (created_at DESC, id DESC), excluding
 * soft-deleted leads. One extra row detects a following page without a COUNT.
 */
export const listLeads = async (
  environment: Env,
  options: LeadPageOptions,
): Promise<LeadPage> => {
  const { cursor, limit, query, tagId, tagScopeId } = options;
  const predicates = [
    eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
    isNull(leads.deletedAt),
  ];
  if (query) {
    predicates.push(leadSearchPredicate(query));
  }

  // Exact-tag and any-tag-in-scope filters are expressions in the same WHERE
  // clause as the keyset cursor, so the page and its count are cut after
  // filtering rather than against only the loaded rows.
  if (tagId) {
    predicates.push(
      sql`EXISTS (SELECT 1 FROM lead_tags AS tag_filter WHERE tag_filter.lead_id = ${leads.id} AND tag_filter.tag_id = ${tagId})`,
    );
  }

  if (tagScopeId) {
    predicates.push(
      sql`EXISTS (SELECT 1 FROM lead_tags AS tag_filter WHERE tag_filter.lead_id = ${leads.id} AND tag_filter.scope_id = ${tagScopeId})`,
    );
  }

  if (cursor) {
    const cursorTime = Date.parse(cursor.createdAt);
    predicates.push(
      sql`(${leads.createdAt} < ${cursorTime} OR (${leads.createdAt} = ${cursorTime} AND ${leads.id} < ${cursor.id}))`,
    );
  }

  const rows = await getDatabase(environment)
    .select({
      createdAt: leads.createdAt,
      customFields: leads.customFields,
      deletedAt: leads.deletedAt,
      duplicateCount: duplicateCountExpression,
      email: leads.email,
      estimatedValue: leads.estimatedValue,
      firstName: leads.firstName,
      id: leads.id,
      lastName: leads.lastName,
      origin: leads.origin,
      skippedFields: leads.skippedFields,
      source: leads.source,
      tagsJson: tagsJsonExpression,
      tokenId: leads.tokenId,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .where(and(...predicates))
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    leads: pageRows.map((row) =>
      toLead(row, { tags: parseTagsJson(row.tagsJson) }),
    ),
    nextCursor:
      hasNextPage && last
        ? encodeKeysetCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
};

export const getLead = async (
  environment: Env,
  leadId: string,
): Promise<LeadRecord | null> => {
  const row = await getDatabase(environment)
    .select({
      ...getTableColumns(leads),
      duplicateCount: duplicateCountExpression,
      tagsJson: tagsJsonExpression,
    })
    .from(leads)
    .where(
      and(eq(leads.workspaceId, DEFAULT_WORKSPACE_ID), eq(leads.id, leadId)),
    )
    .get();
  if (!row) {
    return null;
  }

  const token = row.tokenId
    ? await getDatabase(environment)
        .select({ name: apiTokens.name, type: apiTokens.type })
        .from(apiTokens)
        .where(eq(apiTokens.id, row.tokenId))
        .get()
    : undefined;
  return toLead(row, {
    rawPayload: row.rawPayload,
    tags: parseTagsJson(row.tagsJson),
    tokenName: token?.name ?? null,
    tokenType: token?.type ?? null,
  });
};

export const listLeadActivities = async (environment: Env, leadId: string) =>
  getDatabase(environment)
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(activities.leadId, leadId),
      ),
    )
    .orderBy(desc(activities.createdAt));

const randomToken = (prefix: string): string =>
  `${prefix}${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;

const hashToken = async (token: string): Promise<string> => {
  const source = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
};

const TOKEN_DEFAULT_TTL_MS = 90 * 86_400_000;

export const createApiToken = async (
  environment: Env,
  input: { expiresAt?: null | string; name: string; type: 'api' | 'browser' },
) => {
  const raw = randomToken(input.type === 'browser' ? 'lsc_pub_' : 'lsc_');
  const record = {
    createdAt: now(),
    expiresAt:
      input.expiresAt === undefined
        ? new Date(Date.now() + TOKEN_DEFAULT_TTL_MS)
        : input.expiresAt === null
          ? null
          : new Date(input.expiresAt),
    id: id(),
    name: input.name,
    prefix: raw.slice(0, 12),
    scope: 'intake:write',
    token: input.type === 'browser' ? raw : null,
    tokenHash: input.type === 'api' ? await hashToken(raw) : null,
    type: input.type,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(apiTokens).values(record);
  // API tokens are shown exactly once; browser tokens are stored so they can
  // be copied into a site again. The hash never leaves the server.
  return {
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    revokedAt: null,
    scope: record.scope,
    token: raw,
    type: record.type,
  };
};

export const listApiTokens = async (environment: Env) =>
  getDatabase(environment)
    .select({
      createdAt: apiTokens.createdAt,
      expiresAt: apiTokens.expiresAt,
      id: apiTokens.id,
      lastUsedAt: apiTokens.lastUsedAt,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      revokedAt: apiTokens.revokedAt,
      scope: apiTokens.scope,
      token: apiTokens.token,
      type: apiTokens.type,
    })
    .from(apiTokens)
    .where(eq(apiTokens.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(desc(apiTokens.createdAt));

export const revokeApiToken = async (environment: Env, tokenId: string) => {
  const result = await getDatabase(environment)
    .update(apiTokens)
    .set({ revokedAt: now() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  return result.meta.changes > 0;
};

// --- Single-use staff invitations ----------------------------------------
//
// The raw token exists only in the create response; persistence is the
// SHA-256 hash only. The validate endpoint never consumes an invitation;
// redemption happens at registration.

const INVITE_DEFAULT_TTL_MS = 7 * 86_400_000;

export type InviteRecord = {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  name: string;
  prefix: string;
  revokedAt: Date | null;
  usedAt: Date | null;
};

export const createStaffInvite = async (
  environment: Env,
  name: string,
  expiresAt?: string,
): Promise<InviteRecord & { token: string }> => {
  const raw = `lsc_${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;
  const tokenHash = await hashToken(raw);
  const record: InviteRecord = {
    createdAt: now(),
    expiresAt:
      expiresAt === undefined
        ? new Date(Date.now() + INVITE_DEFAULT_TTL_MS)
        : new Date(expiresAt),
    id: id(),
    name,
    prefix: raw.slice(0, 12),
    revokedAt: null,
    usedAt: null,
  };
  await getDatabase(environment)
    .insert(staffInvites)
    .values({
      ...record,
      tokenHash,
    });
  return { ...record, token: raw };
};

export const listStaffInvites = async (environment: Env) =>
  getDatabase(environment)
    .select({
      createdAt: staffInvites.createdAt,
      expiresAt: staffInvites.expiresAt,
      id: staffInvites.id,
      name: staffInvites.name,
      prefix: staffInvites.prefix,
      revokedAt: staffInvites.revokedAt,
      usedAt: staffInvites.usedAt,
    })
    .from(staffInvites)
    .orderBy(desc(staffInvites.createdAt));

export const revokeStaffInvite = async (
  environment: Env,
  inviteId: string,
): Promise<boolean> => {
  const result = await getDatabase(environment)
    .update(staffInvites)
    .set({ revokedAt: now() })
    .where(eq(staffInvites.id, inviteId))
    .run();
  return result.meta.changes > 0;
};

/**
 * Resolves a presented raw invite token to an available staff-invite
 * grant. Returns undefined when the token does not match an unrevoked,
 * unused, unexpired invite.
 */
export const availableStaffInviteGrant = async (
  environment: Env,
  token: string,
): Promise<RegistrationGrant | undefined> => {
  if (token === '') {
    return undefined;
  }

  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .get();
  if (
    record === undefined ||
    record.revokedAt !== null ||
    record.usedAt !== null ||
    record.expiresAt.getTime() <= now().getTime()
  ) {
    return undefined;
  }

  return { kind: 'invite', tokenHash };
};

/**
 * Non-consuming invitation check: available only while unrevoked, unused,
 * and unexpired.
 */
export const checkStaffInviteAvailability = async (
  environment: Env,
  token: string,
): Promise<boolean> =>
  (await availableStaffInviteGrant(environment, token)) !== undefined;

/**
 * Bootstrap grant availability: the seeded singleton must be unconsumed and
 * unexpired, and no account may exist yet (the current-account rule of
 * registration redemption).
 */
export const isBootstrapGrantAvailable = async (
  environment: Env,
): Promise<boolean> => {
  const database = getDatabase(environment);
  const [bootstrap, account] = await Promise.all([
    database
      .select({
        consumedAt: bootstrapState.consumedAt,
        expiresAt: bootstrapState.expiresAt,
      })
      .from(bootstrapState)
      .where(eq(bootstrapState.id, 'default'))
      .get(),
    database.select({ id: user.id }).from(user).limit(1).get(),
  ]);
  return (
    bootstrap !== undefined &&
    bootstrap.consumedAt === null &&
    account === undefined &&
    bootstrap.expiresAt.getTime() > now().getTime()
  );
};

export type StaffAccountRecord = {
  disabledAt: Date | null;
  email: string;
  id: string;
  name: string;
};

const staffAccountColumns = {
  disabledAt: user.disabledAt,
  email: user.email,
  id: user.id,
  name: user.name,
} as const;

/**
 * Lists every staff account (every account is staff) with the public
 * projection: id, name, email, and the durable disabled state.
 */
export const listStaffAccounts = async (
  environment: Env,
): Promise<StaffAccountRecord[]> =>
  getDatabase(environment)
    .select(staffAccountColumns)
    .from(user)
    .orderBy(asc(user.email), asc(user.id));

/**
 * Resolves a normalized (lowercase) email to its staff-account record.
 */
export const getStaffAccountByEmail = async (
  environment: Env,
  email: string,
): Promise<StaffAccountRecord | undefined> =>
  getDatabase(environment)
    .select(staffAccountColumns)
    .from(user)
    .where(eq(user.email, email))
    .get();

export type SetStaffDisabledOutcome =
  | { kind: 'last-enabled' }
  | { kind: 'not-found' }
  | { kind: 'self' }
  | { kind: 'updated'; record: StaffAccountRecord };

/**
 * Durable staff revocation (stage s5). Disabling writes the flag and
 * deletes every session of the account in ONE D1 batch (single
 * transaction): a disabled account can never hold a live session. The
 * session DELETE is scoped to rows whose owner is disabled after the
 * UPDATE, so a concurrently no-op update can never revoke a
 * still-enabled account's sessions. Re-enabling clears the flag only:
 * deleted session rows are never restored, so the account keeps its
 * credentials but must sign in again.
 *
 * `actorEmail` identifies the signed-in admin performing the change and
 * enforces the self-disable protection; the enabled-count guard enforces
 * the last-enabled-account protection atomically with the UPDATE.
 */
export const setStaffAccountDisabled = async (
  environment: Env,
  userId: string,
  disabled: boolean,
  actorEmail: string,
): Promise<SetStaffDisabledOutcome> => {
  const database = getDatabase(environment);
  const target = await database
    .select(staffAccountColumns)
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (target === undefined) {
    return { kind: 'not-found' };
  }

  const isDisabled = target.disabledAt !== null;
  if (disabled === isDisabled) {
    // Idempotent: the requested state already holds.
    return { kind: 'updated', record: target };
  }

  if (disabled) {
    if (target.email === actorEmail.toLowerCase()) {
      return { kind: 'self' };
    }

    const enabled = await database
      .select({ count: sql<number>`count(*)` })
      .from(user)
      .where(isNull(user.disabledAt))
      .get();
    if (Number(enabled?.count ?? 0) <= 1) {
      return { kind: 'last-enabled' };
    }

    const timestamp = new Date();
    const [result] = await database.batch([
      database
        .update(user)
        .set({ disabledAt: timestamp, updatedAt: timestamp })
        .where(
          and(
            eq(user.id, userId),
            isNull(user.disabledAt),
            sql`(select count(*) from user where disabled_at is null) >= 2`,
          ),
        ),
      database
        .delete(session)
        .where(
          and(
            eq(session.userId, userId),
            sql`(select disabled_at from user where id = ${userId}) is not null`,
          ),
        ),
    ]);
    if (result.meta.changes === 0) {
      // Lost a concurrent race; re-derive the outcome from the committed
      // state instead of guessing.
      const current = await database
        .select(staffAccountColumns)
        .from(user)
        .where(eq(user.id, userId))
        .get();
      if (current === undefined) {
        return { kind: 'not-found' };
      }

      if (current.disabledAt === null) {
        return { kind: 'last-enabled' };
      }

      return { kind: 'updated', record: current };
    }

    return { kind: 'updated', record: { ...target, disabledAt: timestamp } };
  }

  const [updated] = await database.batch([
    database
      .update(user)
      .set({ disabledAt: null, updatedAt: new Date() })
      .where(and(eq(user.id, userId), isNotNull(user.disabledAt))),
  ]);
  if (updated.meta.changes === 0) {
    // A concurrent enable already cleared the flag; re-read the committed
    // state.
    const current = await database
      .select(staffAccountColumns)
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (current === undefined) {
      return { kind: 'not-found' };
    }

    return { kind: 'updated', record: current };
  }

  return { kind: 'updated', record: { ...target, disabledAt: null } };
};

// --- Self-service session management ---------------------------------------
//
// The Better Auth session row's token is a bearer-equivalent secret, so the
// account surface projects only ids and metadata and never returns it.

export type AccountSessionRecord = {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipAddress: null | string;
  userAgent: null | string;
};

const accountSessionColumns = {
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  id: session.id,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
} as const;

// Both deletion sinks must validate the caller in the mutation statement.
// Checking authority separately would allow recovery to revoke the caller
// between that read and the DELETE.
const hasLiveAccountSession = (
  database: ReturnType<typeof getDatabase>,
  userId: string,
  currentSessionId: string,
) => {
  const callerSession = alias(session, 'account_session_authority');
  return exists(
    database
      .select({ id: callerSession.id })
      .from(callerSession)
      .where(
        and(
          eq(callerSession.id, currentSessionId),
          eq(callerSession.userId, userId),
          gt(
            callerSession.expiresAt,
            sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
          ),
        ),
      ),
  );
};

/**
 * Lists the account's live sessions (unexpired), newest first, never
 * including token material.
 */
export const listAccountSessions = async (
  environment: Env,
  userId: string,
): Promise<AccountSessionRecord[]> =>
  getDatabase(environment)
    .select(accountSessionColumns)
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.createdAt));

/**
 * Deletes one of the account's own sessions by row id. Returns false when
 * the id matches no session of this account (including one already
 * revoked or belonging to somebody else), or when caller authority is no
 * longer live. The caller cannot be the target. Expired target rows are also
 * deleted when the caller still owns a live session.
 */
export const revokeAccountSession = async (
  environment: Env,
  userId: string,
  sessionId: string,
  currentSessionId: string,
): Promise<boolean> => {
  const database = getDatabase(environment);
  const [result] = await database
    .delete(session)
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        sql`${session.id} <> ${currentSessionId}`,
        hasLiveAccountSession(database, userId, currentSessionId),
      ),
    )
    .returning({ id: session.id });
  return result !== undefined;
};

/**
 * Deletes every session of the account except the current one, identified by
 * its row id (resolved from the authenticated request). Returns the number
 * of active sessions revoked; expired rows are also cleaned up. The caller
 * must still own a live session when this DELETE executes, so an operation
 * authenticated before password rotation cannot delete its replacement.
 */
export const revokeOtherAccountSessions = async (
  environment: Env,
  userId: string,
  currentSessionId: string,
): Promise<number> => {
  const revokedAt = new Date();
  const database = getDatabase(environment);
  const revoked = await database
    .delete(session)
    .where(
      and(
        eq(session.userId, userId),
        sql`${session.id} <> ${currentSessionId}`,
        hasLiveAccountSession(database, userId, currentSessionId),
      ),
    )
    .returning({ expiresAt: session.expiresAt });
  return revoked.filter((row) => row.expiresAt > revokedAt).length;
};

/**
 * Intake authorization gate. A token is usable only while unrevoked,
 * scoped to intake:write, and unexpired: legacy rows with a NULL expiry
 * stay valid, and a row whose expiresAt is NOT strictly after the current
 * instant is rejected (expiresAt <= now means expired). The check runs
 * before any idempotency or domain write in the intake route.
 */
export const isIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        eq(apiTokens.type, 'api'),
        eq(apiTokens.scope, 'intake:write'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

/**
 * A browser intake token is write-only: it can create a lead through
 * `/v1/public/intakes/:token` and nothing else. Returns the token row
 * (id used as lead provenance) or null. The value is stored verbatim
 * because browser tokens are safe to embed and copy.
 */
export const isBrowserIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.token, token),
        eq(apiTokens.type, 'browser'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

export type StoredIntakeKey = {
  requestHash: null | string;
  responseJson: Record<string, unknown>;
};

export const getIntakeKey = async (
  environment: Env,
  idempotencyKey: string,
): Promise<null | StoredIntakeKey> => {
  const row = await getDatabase(environment)
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(idempotencyKeys.key, idempotencyKey),
      ),
    )
    .get();
  return row
    ? {
        requestHash: row.requestHash,
        responseJson: row.responseJson as Record<string, unknown>,
      }
    : null;
};

const checkStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): 'conflict' | 'legacy_unverifiable' | 'none' | 'replay' => {
  if (!stored) {
    return 'none';
  }

  if (stored.requestHash === null) {
    return 'legacy_unverifiable';
  }

  if (stored.requestHash === requestHash) {
    return 'replay';
  }

  return 'conflict';
};

export type IntakePersistenceOutcome =
  | { kind: 'conflict' }
  | { kind: 'created'; response: IntakeResponse }
  | { kind: 'legacy_unverifiable'; storedResponse: Record<string, unknown> }
  | { kind: 'replayed'; response: IntakeResponse };

/**
 * Interprets an already stored key for this request. Returns undefined when
 * no accepted row exists (i.e. this is a new submission). Used both before
 * the first write and after a batch collision, so concurrent callers apply
 * the exact same replay/conflict/legacy rules.
 */
export const outcomeForStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): IntakePersistenceOutcome | undefined => {
  if (stored === null) {
    return undefined;
  }

  switch (checkStoredIntakeKey(stored, requestHash)) {
    case 'conflict':
      return { kind: 'conflict' };
    case 'legacy_unverifiable':
      return {
        kind: 'legacy_unverifiable',
        storedResponse: stored.responseJson,
      };
    case 'replay':
      return {
        kind: 'replayed',
        response: stored.responseJson as unknown as IntakeResponse,
      };
    default:
      return undefined;
  }
};

// --- Tags catalog and lead assignments -------------------------------------
//
// A scope is inferred from a `prefix:value` tag name and owns one shared
// color. A tag stores a stable id; a scoped tag points at its scope and a
// standalone tag carries its own color. Exclusivity is enforced by the
// `lead_tags_lead_scope_unique` partial unique index, not by the UI.

type TagPlan = {
  assignments: Array<{ scopeId: null | string; tagId: string }>;
  newScopes: Array<{ color: TagColor; id: string; prefix: string }>;
  newTags: Array<{
    color: null | TagColor;
    id: string;
    name: string;
    scopeId: null | string;
  }>;
};

/**
 * Deterministic last-in-payload-wins: a later scoped tag replaces an earlier
 * sibling in the same scope; standalone tags de-duplicate by name.
 */
const dedupeTagSpecs = (specs: readonly TagSpec[]): TagSpec[] => {
  const result: TagSpec[] = [];
  const scoped = new Map<string, number>();
  const standalone = new Set<string>();
  for (const spec of specs) {
    if (spec.prefix) {
      const index = scoped.get(spec.prefix);
      if (index === undefined) {
        scoped.set(spec.prefix, result.length);
        result.push(spec);
      } else {
        result[index] = spec;
      }
    } else if (!standalone.has(spec.name)) {
      standalone.add(spec.name);
      result.push(spec);
    }
  }

  return result;
};

const errorText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(' | ');
};

const isUniqueViolation = (error: unknown): boolean =>
  /UNIQUE constraint failed/iu.test(errorText(error));

const uniqueConstraintTarget = (error: unknown): null | string => {
  const match = /UNIQUE constraint failed: ([\w.]+)/iu.exec(errorText(error));
  return match?.[1]?.toLowerCase() ?? null;
};

/**
 * Reads the current catalog and plans the scopes/tags needed for a set of
 * specs. Existing rows keep their ids; missing rows get ids generated here so
 * the caller can reference them in one atomic batch. A concurrent writer can
 * still win the unique index, which the caller retries against the re-read
 * catalog.
 */
const resolveTagPlan = async (
  environment: Env,
  specs: readonly TagSpec[],
): Promise<TagPlan> => {
  const deduped = dedupeTagSpecs(specs);
  const database = getDatabase(environment);
  const scopeRows = await database
    .select({ id: tagScopes.id, prefix: tagScopes.prefix })
    .from(tagScopes)
    .where(eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID));
  const tagRows = await database
    .select({ id: tags.id, name: tags.name, scopeId: tags.scopeId })
    .from(tags)
    .where(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID));
  const scopesByPrefix = new Map<string, string>(
    scopeRows.map((row) => [row.prefix, row.id]),
  );
  const tagsByKey = new Map<string, string>(
    tagRows.map((row) => [`${row.scopeId ?? ''}\u0000${row.name}`, row.id]),
  );

  const newScopes: TagPlan['newScopes'] = [];
  const newTags: TagPlan['newTags'] = [];
  const assignments: TagPlan['assignments'] = [];
  for (const spec of deduped) {
    let scopeId: null | string = null;
    if (spec.prefix) {
      const existingScope = scopesByPrefix.get(spec.prefix);
      if (existingScope === undefined) {
        const plannedScope = newScopes.find(
          (scope) => scope.prefix === spec.prefix,
        );
        if (plannedScope) {
          scopeId = plannedScope.id;
        } else {
          scopeId = id();
          newScopes.push({
            color: nextTagColor(scopeRows.length + newScopes.length),
            id: scopeId,
            prefix: spec.prefix,
          });
        }
      } else {
        scopeId = existingScope;
      }
    }

    const key = `${scopeId ?? ''}\u0000${spec.name}`;
    let tagId = tagsByKey.get(key);
    if (tagId === undefined) {
      const plannedTag = newTags.find(
        (tag) => tag.scopeId === scopeId && tag.name === spec.name,
      );
      if (plannedTag) {
        tagId = plannedTag.id;
      } else {
        tagId = id();
        newTags.push({
          color: scopeId ? null : nextTagColor(tagRows.length + newTags.length),
          id: tagId,
          name: spec.name,
          scopeId,
        });
      }
    }

    assignments.push({ scopeId, tagId });
  }

  return { assignments, newScopes, newTags };
};

const tagPlanStatements = (
  environment: Env,
  plan: TagPlan,
  timestamp: number,
): Statement[] => [
  ...plan.newScopes.map((scope) =>
    prepare(
      environment.DB,
      'INSERT INTO tag_scopes (id, workspace_id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      scope.id,
      DEFAULT_WORKSPACE_ID,
      scope.prefix,
      scope.color,
      timestamp,
      timestamp,
    ),
  ),
  ...plan.newTags.map((tag) =>
    prepare(
      environment.DB,
      'INSERT INTO tags (id, workspace_id, name, scope_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      tag.id,
      DEFAULT_WORKSPACE_ID,
      tag.name,
      tag.scopeId,
      tag.color,
      timestamp,
      timestamp,
    ),
  ),
];

const leadTagStatements = (
  environment: Env,
  leadId: string,
  assignments: TagPlan['assignments'],
  timestamp: number,
): Statement[] =>
  assignments.map((assignment) =>
    prepare(
      environment.DB,
      'INSERT INTO lead_tags (id, workspace_id, lead_id, tag_id, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      id(),
      DEFAULT_WORKSPACE_ID,
      leadId,
      assignment.tagId,
      assignment.scopeId,
      timestamp,
    ),
  );

const tagViewSelect = {
  color: tags.color,
  createdAt: tags.createdAt,
  id: tags.id,
  name: tags.name,
  scopeColor: tagScopes.color,
  scopeId: tags.scopeId,
  scopePrefix: tagScopes.prefix,
  updatedAt: tags.updatedAt,
} as const;

const getTagView = async (
  environment: Env,
  tagId: string,
): Promise<TagViewRecord | undefined> => {
  const row = await getDatabase(environment)
    .select(tagViewSelect)
    .from(tags)
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId))
    .where(and(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID), eq(tags.id, tagId)))
    .get();
  return row ? toTagViewRecord(row) : undefined;
};

const getScopeView = async (
  environment: Env,
  scopeId: string,
): Promise<TagScopeRecord | undefined> => {
  const row = await getDatabase(environment)
    .select()
    .from(tagScopes)
    .where(
      and(
        eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(tagScopes.id, scopeId),
      ),
    )
    .get();
  return row
    ? {
        color: asTagColor(row.color),
        createdAt: row.createdAt,
        id: row.id,
        prefix: row.prefix,
        updatedAt: row.updatedAt,
      }
    : undefined;
};

export const listTagCatalog = async (
  environment: Env,
): Promise<{ scopes: TagScopeRecord[]; tags: CatalogTagRecord[] }> => {
  const database = getDatabase(environment);
  const scopeRows = await database
    .select()
    .from(tagScopes)
    .where(eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(asc(tagScopes.prefix));
  const tagRows = await database
    .select({
      ...tagViewSelect,
      leadCount: sql<number>`(SELECT count(*) FROM lead_tags AS usage JOIN leads AS used ON used.id = usage.lead_id WHERE usage.tag_id = ${tags.id} AND used.deleted_at IS NULL)`,
    })
    .from(tags)
    .leftJoin(tagScopes, eq(tagScopes.id, tags.scopeId))
    .where(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID));

  return {
    scopes: scopeRows.map((row) => ({
      color: asTagColor(row.color),
      createdAt: row.createdAt,
      id: row.id,
      prefix: row.prefix,
      updatedAt: row.updatedAt,
    })),
    tags: tagRows
      .map((row) => ({
        ...toTagViewRecord(row),
        leadCount: Number(row.leadCount),
      }))
      .toSorted((left, right) => left.label.localeCompare(right.label)),
  };
};

export type TagMutationOutcome =
  | {
      code: 'scope_conflict' | 'scope_exists' | 'tag_exists';
      kind: 'conflict';
      message: string;
    }
  | { kind: 'not-found' }
  | { kind: 'ok'; tag: TagViewRecord };

const tagConflict = (
  target: null | string,
): Extract<TagMutationOutcome, { kind: 'conflict' }> => {
  if (target?.startsWith('lead_tags')) {
    return {
      code: 'scope_conflict',
      kind: 'conflict',
      message:
        'Some assigned leads already have another tag in that scope. Resolve those conflicts before moving this tag.',
    };
  }

  if (target?.startsWith('tag_scopes')) {
    return {
      code: 'scope_exists',
      kind: 'conflict',
      message: 'That scope already exists. Choose another prefix.',
    };
  }

  return {
    code: 'tag_exists',
    kind: 'conflict',
    message: 'That tag already exists. Choose another name.',
  };
};

const findTagBySpec = async (
  environment: Env,
  scopeId: null | string,
  name: string,
) =>
  getDatabase(environment)
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        eq(tags.workspaceId, DEFAULT_WORKSPACE_ID),
        scopeId === null ? isNull(tags.scopeId) : eq(tags.scopeId, scopeId),
        eq(tags.name, name),
      ),
    )
    .get();

export const createTag = async (
  environment: Env,
  spec: TagSpec,
): Promise<TagMutationOutcome> => {
  const database = getDatabase(environment);
  const scope = spec.prefix
    ? await database
        .select()
        .from(tagScopes)
        .where(
          and(
            eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID),
            eq(tagScopes.prefix, spec.prefix),
          ),
        )
        .get()
    : undefined;
  const scopeId = scope?.id ?? null;
  if (await findTagBySpec(environment, scopeId, spec.name)) {
    return tagConflict('tags.workspace_name');
  }

  const scopeCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(tagScopes)
    .where(eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID))
    .get();
  const tagCount = await database
    .select({ count: sql<number>`count(*)` })
    .from(tags)
    .where(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID))
    .get();
  const timestamp = now().getTime();
  const effectiveScopeId = spec.prefix ? (scopeId ?? id()) : null;
  const tagId = id();
  const statements: Statement[] = [];
  if (spec.prefix && !scope) {
    statements.push(
      prepare(
        environment.DB,
        'INSERT INTO tag_scopes (id, workspace_id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        effectiveScopeId,
        DEFAULT_WORKSPACE_ID,
        spec.prefix,
        nextTagColor(Number(scopeCount?.count ?? 0)),
        timestamp,
        timestamp,
      ),
    );
  }

  statements.push(
    prepare(
      environment.DB,
      'INSERT INTO tags (id, workspace_id, name, scope_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      tagId,
      DEFAULT_WORKSPACE_ID,
      spec.name,
      effectiveScopeId,
      effectiveScopeId ? null : nextTagColor(Number(tagCount?.count ?? 0)),
      timestamp,
      timestamp,
    ),
  );

  try {
    await executeAtomically(environment.DB, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return tagConflict(uniqueConstraintTarget(error));
    }

    throw error;
  }

  const tag = await getTagView(environment, tagId);
  return tag ? { kind: 'ok', tag } : { kind: 'not-found' };
};

export const updateTag = async (
  environment: Env,
  tagId: string,
  patch: { color?: TagColor; name?: TagSpec },
): Promise<TagMutationOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select()
    .from(tags)
    .where(and(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID), eq(tags.id, tagId)))
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  const timestamp = now().getTime();
  const statements: Statement[] = [];
  let targetScopeId: null | string = current.scopeId;
  let targetColor = current.color;
  let oldScopeId: null | string = null;
  let moved = false;

  if (patch.name) {
    if (patch.name.prefix) {
      const scope = await database
        .select()
        .from(tagScopes)
        .where(
          and(
            eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID),
            eq(tagScopes.prefix, patch.name.prefix),
          ),
        )
        .get();
      if (scope) {
        targetScopeId = scope.id;
      } else {
        targetScopeId = id();
        const scopeCount = await database
          .select({ count: sql<number>`count(*)` })
          .from(tagScopes)
          .where(eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID))
          .get();
        statements.push(
          prepare(
            environment.DB,
            'INSERT INTO tag_scopes (id, workspace_id, prefix, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).bind(
            targetScopeId,
            DEFAULT_WORKSPACE_ID,
            patch.name.prefix,
            nextTagColor(Number(scopeCount?.count ?? 0)),
            timestamp,
            timestamp,
          ),
        );
      }
    } else {
      targetScopeId = null;
      if (!targetColor) {
        const tagCount = await database
          .select({ count: sql<number>`count(*)` })
          .from(tags)
          .where(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID))
          .get();
        targetColor = nextTagColor(Number(tagCount?.count ?? 0));
      }
    }

    moved = targetScopeId !== current.scopeId;
    if (moved) {
      oldScopeId = current.scopeId;
    }

    statements.push(
      prepare(
        environment.DB,
        'UPDATE tags SET name = ?, scope_id = ?, color = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      ).bind(
        patch.name.name,
        targetScopeId,
        targetColor,
        timestamp,
        tagId,
        DEFAULT_WORKSPACE_ID,
      ),
    );
    if (moved) {
      statements.push(
        prepare(
          environment.DB,
          'UPDATE lead_tags SET scope_id = ? WHERE tag_id = ? AND workspace_id = ?',
        ).bind(targetScopeId, tagId, DEFAULT_WORKSPACE_ID),
      );
    }
  }

  if (patch.color) {
    if (targetScopeId) {
      statements.push(
        prepare(
          environment.DB,
          'UPDATE tag_scopes SET color = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
        ).bind(patch.color, timestamp, targetScopeId, DEFAULT_WORKSPACE_ID),
      );
    } else {
      statements.push(
        prepare(
          environment.DB,
          'UPDATE tags SET color = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
        ).bind(patch.color, timestamp, tagId, DEFAULT_WORKSPACE_ID),
      );
    }
  }

  if (moved && oldScopeId) {
    // An inferred scope is pruned once its final tag has been moved out.
    statements.push(
      prepare(
        environment.DB,
        'DELETE FROM tag_scopes WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM tags WHERE scope_id = ?)',
      ).bind(oldScopeId, DEFAULT_WORKSPACE_ID, oldScopeId),
    );
  }

  if (statements.length === 0) {
    const unchanged = await getTagView(environment, tagId);
    return unchanged ? { kind: 'ok', tag: unchanged } : { kind: 'not-found' };
  }

  try {
    await executeAtomically(environment.DB, statements);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return tagConflict(uniqueConstraintTarget(error));
    }

    throw error;
  }

  const tag = await getTagView(environment, tagId);
  return tag ? { kind: 'ok', tag } : { kind: 'not-found' };
};

export type TagScopeMutationOutcome =
  | {
      code: 'scope_exists';
      kind: 'conflict';
      message: string;
    }
  | { kind: 'not-found' }
  | { kind: 'ok'; scope: TagScopeRecord };

export const updateTagScope = async (
  environment: Env,
  scopeId: string,
  patch: { color?: TagColor; prefix?: string },
): Promise<TagScopeMutationOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select()
    .from(tagScopes)
    .where(
      and(
        eq(tagScopes.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(tagScopes.id, scopeId),
      ),
    )
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  try {
    await executeAtomically(environment.DB, [
      prepare(
        environment.DB,
        'UPDATE tag_scopes SET color = ?, prefix = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      ).bind(
        patch.color ?? asTagColor(current.color),
        patch.prefix ?? current.prefix,
        now().getTime(),
        scopeId,
        DEFAULT_WORKSPACE_ID,
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        code: 'scope_exists',
        kind: 'conflict',
        message: 'That scope already exists. Choose another name.',
      };
    }

    throw error;
  }

  const scope = await getScopeView(environment, scopeId);
  return scope ? { kind: 'ok', scope } : { kind: 'not-found' };
};

export type DeleteTagOutcome =
  { kind: 'deleted'; removed: number } | { kind: 'not-found' };

export const deleteTag = async (
  environment: Env,
  tagId: string,
): Promise<DeleteTagOutcome> => {
  const database = getDatabase(environment);
  const current = await database
    .select({ scopeId: tags.scopeId })
    .from(tags)
    .where(and(eq(tags.workspaceId, DEFAULT_WORKSPACE_ID), eq(tags.id, tagId)))
    .get();
  if (!current) {
    return { kind: 'not-found' };
  }

  const removed = await database
    .select({ count: sql<number>`count(*)` })
    .from(leadTags)
    .innerJoin(leads, eq(leads.id, leadTags.leadId))
    .where(and(eq(leadTags.tagId, tagId), isNull(leads.deletedAt)))
    .get();
  const statements: Statement[] = [
    prepare(
      environment.DB,
      'DELETE FROM lead_tags WHERE tag_id = ? AND workspace_id = ?',
    ).bind(tagId, DEFAULT_WORKSPACE_ID),
    prepare(
      environment.DB,
      'DELETE FROM tags WHERE id = ? AND workspace_id = ?',
    ).bind(tagId, DEFAULT_WORKSPACE_ID),
  ];
  if (current.scopeId) {
    statements.push(
      prepare(
        environment.DB,
        'DELETE FROM tag_scopes WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM tags WHERE scope_id = ?)',
      ).bind(current.scopeId, DEFAULT_WORKSPACE_ID, current.scopeId),
    );
  }

  await executeAtomically(environment.DB, statements);
  return { kind: 'deleted', removed: Number(removed?.count ?? 0) };
};

const resolveAssignmentsByIds = async (
  environment: Env,
  tagIds: readonly string[],
): Promise<{
  assignments: TagPlan['assignments'];
  unknown: string[];
}> => {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) {
    return { assignments: [], unknown: [] };
  }

  const rows = await getDatabase(environment)
    .select({ id: tags.id, scopeId: tags.scopeId })
    .from(tags)
    .where(
      and(
        eq(tags.workspaceId, DEFAULT_WORKSPACE_ID),
        sql`${tags.id} IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`,
      ),
    );
  const byId = new Map<string, null | string>(
    rows.map((row) => [row.id, row.scopeId]),
  );
  const unknown = unique.filter((tagId) => !byId.has(tagId));
  const assignments: TagPlan['assignments'] = [];
  const scopeIndex = new Map<string, number>();
  for (const tagId of unique) {
    const scopeId = byId.get(tagId);
    if (scopeId === undefined) {
      continue;
    }

    if (scopeId === null) {
      assignments.push({ scopeId, tagId });
    } else {
      const index = scopeIndex.get(scopeId);
      if (index === undefined) {
        scopeIndex.set(scopeId, assignments.length);
        assignments.push({ scopeId, tagId });
      } else {
        // Last-in-list wins within an exclusive scope.
        assignments[index] = { scopeId, tagId };
      }
    }
  }

  return { assignments, unknown };
};

export type SetLeadTagsOutcome =
  | { kind: 'not-found' }
  | { kind: 'ok'; tags: TagViewRecord[] }
  | { kind: 'unknown-tag'; tagIds: string[] };

export const setLeadTags = async (
  environment: Env,
  leadId: string,
  tagIds: readonly string[],
): Promise<SetLeadTagsOutcome> => {
  const database = getDatabase(environment);
  const lead = await database
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .get();
  if (!lead) {
    return { kind: 'not-found' };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolved = await resolveAssignmentsByIds(environment, tagIds);
    if (resolved.unknown.length > 0) {
      return { kind: 'unknown-tag', tagIds: resolved.unknown };
    }

    const statements: Statement[] = [
      prepare(
        environment.DB,
        'DELETE FROM lead_tags WHERE lead_id = ? AND workspace_id = ?',
      ).bind(leadId, DEFAULT_WORKSPACE_ID),
      ...leadTagStatements(
        environment,
        leadId,
        resolved.assignments,
        now().getTime(),
      ),
    ];
    try {
      await executeAtomically(environment.DB, statements);
      const map = await tagViewsForLeads(database, [leadId]);
      return { kind: 'ok', tags: map.get(leadId) ?? [] };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('The lead tags could not be saved after retries.');
};

export type BulkTagOutcome =
  | { affected: number; kind: 'ok' }
  | { kind: 'unknown-lead'; leadIds: string[] }
  | { kind: 'unknown-tag'; tagIds: string[] };

export const bulkTag = async (
  environment: Env,
  leadIds: readonly string[],
  tagIds: readonly string[],
  mode: 'add' | 'remove',
): Promise<BulkTagOutcome> => {
  const database = getDatabase(environment);
  const uniqueLeads = [...new Set(leadIds)];
  const uniqueTags = [...new Set(tagIds)];
  const existingLeads = await database
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(uniqueLeads)}))`,
      ),
    );
  const existingIds = new Set(existingLeads.map((row) => row.id));
  const missingLeads = uniqueLeads.filter((leadId) => !existingIds.has(leadId));
  if (missingLeads.length > 0) {
    return { kind: 'unknown-lead', leadIds: missingLeads };
  }

  if (mode === 'remove') {
    const result = await database
      .delete(leadTags)
      .where(
        and(
          eq(leadTags.workspaceId, DEFAULT_WORKSPACE_ID),
          sql`${leadTags.leadId} IN (SELECT value FROM json_each(${JSON.stringify(uniqueLeads)}))`,
          sql`${leadTags.tagId} IN (SELECT value FROM json_each(${JSON.stringify(uniqueTags)}))`,
        ),
      )
      .run();
    return { affected: Number(result.meta.changes), kind: 'ok' };
  }

  const resolved = await resolveAssignmentsByIds(environment, uniqueTags);
  if (resolved.unknown.length > 0) {
    return { kind: 'unknown-tag', tagIds: resolved.unknown };
  }

  const scopedIds = resolved.assignments
    .map((assignment) => assignment.scopeId)
    .filter((scopeId): scopeId is string => scopeId !== null);
  const timestamp = now().getTime();
  const statements: Statement[] = [
    prepare(
      environment.DB,
      `DELETE FROM lead_tags
        WHERE workspace_id = ?
          AND lead_id IN (SELECT value FROM json_each(?))
          AND (
            tag_id IN (SELECT value FROM json_each(?))
            OR scope_id IN (SELECT value FROM json_each(?))
          )`,
    ).bind(
      DEFAULT_WORKSPACE_ID,
      JSON.stringify(uniqueLeads),
      JSON.stringify(uniqueTags),
      JSON.stringify(scopedIds),
    ),
    prepare(
      environment.DB,
      `INSERT INTO lead_tags (id, workspace_id, lead_id, tag_id, scope_id, created_at)
        SELECT
          '0' || substr(hex(randomblob(13)), 1, 25),
          l.workspace_id,
          l.id,
          json_extract(assignment.value, '$.tagId'),
          json_extract(assignment.value, '$.scopeId'),
          ?
        FROM json_each(?) AS ids
        JOIN leads AS l
          ON l.id = ids.value
          AND l.workspace_id = ?
          AND l.deleted_at IS NULL
        CROSS JOIN json_each(?) AS assignment`,
    ).bind(
      timestamp,
      JSON.stringify(uniqueLeads),
      DEFAULT_WORKSPACE_ID,
      JSON.stringify(resolved.assignments),
    ),
  ];
  await executeAtomically(environment.DB, statements);
  return { affected: uniqueLeads.length, kind: 'ok' };
};

export const createLeadAtomically = async (
  environment: Env,
  input: IntakeRequest,
  idempotencyKey: string,
  requestHash: string,
  provenance?: { origin: null | string; tokenId: null | string },
  rawPayload?: unknown,
  tagSpecs: readonly TagSpec[] = [],
): Promise<IntakePersistenceOutcome> => {
  // Raw D1 binds do not accept Date, so work in Unix milliseconds directly.
  const timestamp = now().getTime();
  const leadId = id();
  const activityId = id();
  const email = normalizeEmail(input.email);
  const response: IntakeResponse = { created: true, leadId };
  const leadStatement = prepare(
    environment.DB,
    `INSERT INTO leads (
        id, workspace_id, email, first_name, last_name,
        source, estimated_value, custom_fields, raw_payload, skipped_fields,
        origin, token_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    leadId,
    DEFAULT_WORKSPACE_ID,
    email,
    input.firstName ?? null,
    input.lastName ?? null,
    input.source,
    input.estimatedValue ?? null,
    JSON.stringify(input.customFields ?? {}),
    rawPayload === undefined ? null : JSON.stringify(rawPayload),
    input.skippedFields ? JSON.stringify(input.skippedFields) : null,
    provenance?.origin ?? null,
    provenance?.tokenId ?? null,
    timestamp,
    timestamp,
  );
  const activityStatement = prepare(
    environment.DB,
    `INSERT INTO activities (
        id, workspace_id, lead_id, kind, body, metadata, created_at
      ) VALUES (?, ?, ?, 'intake', ?, ?, ?)`,
  ).bind(
    activityId,
    DEFAULT_WORKSPACE_ID,
    leadId,
    `Received from ${input.source}`,
    JSON.stringify({ source: input.source }),
    timestamp,
  );
  const idempotencyStatement = prepare(
    environment.DB,
    'INSERT INTO idempotency_keys (workspace_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(
    DEFAULT_WORKSPACE_ID,
    idempotencyKey,
    requestHash,
    JSON.stringify(response),
    timestamp,
  );

  // A concurrent writer can create the same scope/tag between the plan read
  // and the batch, which aborts the whole batch on the unique index. Because
  // the batch is atomic nothing was committed, so a bounded retry re-reads the
  // catalog and rebuilds the plan. New tags stay in the same batch as the
  // lead, so a failure rolls every associated write back.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = await resolveTagPlan(environment, tagSpecs);
    const statements: Statement[] = [
      ...tagPlanStatements(environment, plan, timestamp),
      leadStatement,
      ...leadTagStatements(environment, leadId, plan.assignments, timestamp),
      activityStatement,
      idempotencyStatement,
    ];
    try {
      await executeAtomically(environment.DB, statements);
      return { kind: 'created', response };
    } catch (error) {
      // A unique-key collision on the idempotency row means a concurrent
      // request already committed this key; any other failure committed
      // nothing. Re-read and apply the SAME fingerprint/legacy rules as the
      // fast path — never an unconditional replay.
      const stored = await getIntakeKey(environment, idempotencyKey);
      const outcome = outcomeForStoredIntakeKey(stored, requestHash);
      if (outcome) {
        return outcome;
      }

      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('The intake could not be persisted after tag conflicts.');
};

export const createLead = async (
  environment: Env,
  input: CreateLeadRequest,
  tagSpecs: readonly TagSpec[] = [],
): Promise<LeadRecord> => {
  const ms = now().getTime();
  const leadId = id();
  const email = input.email ? normalizeEmail(input.email) : null;
  const firstName = input.firstName ?? null;
  const lastName = input.lastName ?? null;
  const source = input.source ?? 'Manual entry';
  const estimatedValue = input.estimatedValue ?? null;
  const customFields = input.customFields ?? {};
  const leadStatement = prepare(
    environment.DB,
    `INSERT INTO leads (
        id, workspace_id, email, first_name, last_name,
        source, estimated_value, custom_fields, raw_payload, skipped_fields,
        origin, token_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    leadId,
    DEFAULT_WORKSPACE_ID,
    email,
    firstName,
    lastName,
    source,
    estimatedValue,
    JSON.stringify(customFields),
    ms,
    ms,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const plan = await resolveTagPlan(environment, tagSpecs);
    const statements: Statement[] = [
      ...tagPlanStatements(environment, plan, ms),
      leadStatement,
      ...leadTagStatements(environment, leadId, plan.assignments, ms),
    ];
    try {
      await executeAtomically(environment.DB, statements);
      break;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 2) {
        continue;
      }

      throw error;
    }
  }

  const lead = await getLead(environment, leadId);
  if (!lead) {
    throw new Error('The lead could not be read after creation.');
  }

  return lead;
};

export const updateLead = async (
  environment: Env,
  leadId: string,
  input: UpdateLeadRequest,
): Promise<LeadRecord | null> => {
  const patch: Partial<typeof leads.$inferInsert> = { updatedAt: now() };
  if (input.customFields !== undefined) {
    patch.customFields = input.customFields;
  }

  if (input.email !== undefined) {
    patch.email = input.email ? normalizeEmail(input.email) : null;
  }

  if (input.estimatedValue !== undefined) {
    patch.estimatedValue = input.estimatedValue;
  }

  if (input.firstName !== undefined) {
    patch.firstName = input.firstName;
  }

  if (input.lastName !== undefined) {
    patch.lastName = input.lastName;
  }

  if (input.source !== undefined) {
    patch.source = input.source;
  }

  const result = await getDatabase(environment)
    .update(leads)
    .set(patch)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .run();
  if (result.meta.changes === 0) {
    return null;
  }

  return getLead(environment, leadId);
};

export const softDeleteLeads = async (
  environment: Env,
  ids: readonly string[],
): Promise<number> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return 0;
  }

  // One statement stays atomic without a batch, and the id list travels as a
  // single JSON array parameter, so no variable-length binding can hit D1's
  // 100-parameter cap. json_each is the documented D1 pattern for IN queries:
  // https://developers.cloudflare.com/d1/sql-api/query-json/#expand-arrays-for-in-queries
  const result = await getDatabase(environment)
    .update(leads)
    .set({ deletedAt: now() })
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`,
      ),
    )
    .run();
  return result.meta.changes;
};

export const createLeadActivity = async (
  environment: Env,
  leadId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => {
  const lead = await getLead(environment, leadId);
  if (!lead) {
    return null;
  }

  const record = {
    actorEmail,
    body,
    createdAt: now(),
    id: id(),
    kind,
    leadId,
    metadata: {},
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(activities).values(record);
  return record;
};
