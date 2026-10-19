import { type Env } from '../env';
import {
  apiTokens,
  bootstrapState,
  session,
  staffInvites,
  user,
} from '../schema';
import { getDatabase, hashToken, id, now, randomToken } from '../shared';
import { type RegistrationGrant } from '@/auth/registration-repository';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

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
    .orderBy(desc(apiTokens.createdAt));

export const revokeApiToken = async (environment: Env, tokenId: string) => {
  const result = await getDatabase(environment)
    .update(apiTokens)
    .set({ revokedAt: now() })
    .where(eq(apiTokens.id, tokenId))
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
  const raw = randomToken('lsc_');
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
