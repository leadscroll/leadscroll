import { type Env } from '../env';
import {
  auditLog,
  installationConfig,
  notificationPreferences,
  user,
} from '../schema';
import {
  executeAtomicallyWithResults,
  getDatabase,
  isUniqueViolation,
  prepare,
  randomToken,
  type Statement,
} from '../shared';
import { encodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  type AuditChange,
  type AuditRecord,
  type AuditWrite,
  decodeAuditChanges,
  decodeInstallationConfig,
  DEFAULT_INSTALLATION_CONFIG,
  type InstallationConfig,
  validateAuditWrite,
  validateInstallationConfig,
} from '@/domain/schemas';
import { and, desc, eq, isNull, lt, ne, or } from 'drizzle-orm';

// --- New-lead email notifications -------------------------------------------
//
// Persistence for personal preferences and the installation-wide
// configuration document. Drizzle stays inside this module per the repository
// boundary; recipient selection, provider policy, and delivery live in
// src/application and src/notifications.

export type NotificationPreferenceRecord =
  typeof notificationPreferences.$inferSelect;

// --- Personal preferences ---------------------------------------------------

export const getNotificationPreference = async (
  environment: Env,
  userId: string,
): Promise<NotificationPreferenceRecord | null> => {
  const row = await getDatabase(environment)
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .get();
  return row ?? null;
};

export const upsertNotificationPreference = async (
  environment: Env,
  userId: string,
  newLeadEmail: boolean,
  timestamp: Date,
): Promise<void> => {
  await getDatabase(environment)
    .insert(notificationPreferences)
    .values({
      newLeadEmail,
      updatedAt: timestamp,
      userId,
    })
    .onConflictDoUpdate({
      set: { newLeadEmail, updatedAt: timestamp },
      target: notificationPreferences.userId,
    });
};

export type LeadCreatedRecipient = {
  email: string;
  userId: string;
};

/**
 * Opted-in, enabled recipients for a newly created lead. The manual creator
 * is excluded when an actor is known. Selection is read at notification time
 * rather than written with the lead, so a preference change before the best-
 * effort delivery is honored.
 */
export const listLeadCreatedRecipients = async (
  environment: Env,
  actorUserId: null | string,
): Promise<LeadCreatedRecipient[]> => {
  const rows = await getDatabase(environment)
    .select({ email: user.email, userId: notificationPreferences.userId })
    .from(notificationPreferences)
    .innerJoin(user, eq(user.id, notificationPreferences.userId))
    .where(
      and(
        eq(notificationPreferences.newLeadEmail, true),
        isNull(user.disabledAt),
        actorUserId === null
          ? undefined
          : ne(notificationPreferences.userId, actorUserId),
      ),
    );
  return rows;
};

// --- Installation configuration ---------------------------------------------
//
// One installation-wide singleton JSON document, validated against the versioned
// Effect Schema in src/domain/schemas.ts on every read and before every write.
// Drizzle never types the document shape; `updated_at` is the internal
// compare-and-swap token. A corrupt or unsupported document throws
// `InstallationConfigDecodeError` and is never silently replaced.

export type InstallationConfigRow = {
  document: InstallationConfig;
  updatedAt: number;
};

export class InstallationConfigDecodeError extends Error {
  constructor() {
    super('The installation configuration document is invalid.');
    this.name = 'InstallationConfigDecodeError';
  }
}

export const readInstallationConfig = async (
  environment: Env,
): Promise<InstallationConfigRow> => {
  let row: undefined | { documentJson: InstallationConfig; updatedAt: Date };
  try {
    row = await getDatabase(environment)
      .select({
        documentJson: installationConfig.documentJson,
        updatedAt: installationConfig.updatedAt,
      })
      .from(installationConfig)
      .where(eq(installationConfig.id, 1))
      .get();
  } catch (error) {
    // Drizzle's JSON column mode parses the stored TEXT while mapping the
    // row, so malformed JSON fails here. Report the redacted decode error and
    // leave the stored row untouched; other database faults still propagate.
    if (error instanceof SyntaxError) {
      throw new InstallationConfigDecodeError();
    }

    throw error;
  }

  if (row === undefined) {
    return { document: DEFAULT_INSTALLATION_CONFIG, updatedAt: 0 };
  }

  const document = decodeInstallationConfig(row.documentJson);
  if (document === null) {
    throw new InstallationConfigDecodeError();
  }

  return { document, updatedAt: row.updatedAt.getTime() };
};

const auditStatements = (
  environment: Env,
  input: {
    actorUserId: null | string;
    now: Date;
    records: readonly AuditWrite[];
  },
  writeToken: string,
): Statement[] =>
  input.records.map((record) => {
    const validated = validateAuditWrite(record);
    return prepare(
      environment.DB,
      `INSERT INTO audit_log (
          id, actor_user_id, created_at, action, resource_type,
          resource_id, changes_json
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM installation_config
          WHERE id = 1 AND write_token = ?
        )`,
    ).bind(
      crypto.randomUUID(),
      input.actorUserId,
      input.now.getTime(),
      validated.action,
      validated.resourceType,
      validated.resourceId,
      // The CAS/audit guard is a narrow raw-SQL exception: D1's conditional
      // batch needs the serialized JSON form here, so serialize once after
      // schema validation.
      JSON.stringify(validated.changes),
      writeToken,
    );
  });

export type InstallationConfigWriteInput = {
  actorUserId: null | string;
  audit?: readonly AuditWrite[];
  document: InstallationConfig;
  expectedUpdatedAt: number;
  now: Date;
};

/**
 * Compare-and-swap write. Returns false when `expectedUpdatedAt` is stale; the
 * caller re-reads and retries. The next token is strictly greater than both
 * the caller's clock reading and the token it read, so a backwards clock or
 * two writes in the same millisecond can never reuse a successful token.
 * Audit statements are gated on the writer-specific token produced by this
 * same atomic batch, so a lost race cannot leave a phantom audit entry and a
 * successful write always has its audit rows.
 */
export const writeInstallationConfig = async (
  environment: Env,
  input: InstallationConfigWriteInput,
): Promise<boolean> => {
  // Candidate validation is authoritative even though Drizzle serializes the
  // JSON column; the raw CAS batch below needs the serialized form.
  const document = validateInstallationConfig(input.document);
  const documentJson = JSON.stringify(document);
  const nextUpdatedAt = Math.max(
    input.now.getTime(),
    input.expectedUpdatedAt + 1,
  );
  const writeToken = randomToken('config-');
  const audit = auditStatements(
    environment,
    {
      actorUserId: input.actorUserId,
      now: input.now,
      records: input.audit ?? [],
    },
    writeToken,
  );

  if (input.expectedUpdatedAt === 0) {
    const insert = prepare(
      environment.DB,
      `INSERT INTO installation_config (
          id, document_json, updated_at, write_token
        ) VALUES (1, ?, ?, ?)`,
    ).bind(documentJson, nextUpdatedAt, writeToken);
    try {
      const inserted = await executeAtomicallyWithResults(environment.DB, [
        insert,
        ...audit,
      ]);
      return (inserted[0]?.meta?.changes ?? 0) > 0;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return false;
      }

      throw error;
    }
  }

  const update = prepare(
    environment.DB,
    `UPDATE installation_config
      SET document_json = ?, updated_at = ?, write_token = ?
      WHERE id = 1 AND updated_at = ?`,
  ).bind(documentJson, nextUpdatedAt, writeToken, input.expectedUpdatedAt);
  const results = await executeAtomicallyWithResults(environment.DB, [
    update,
    ...audit,
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
};

// --- Generic audit log ------------------------------------------------------

export type AuditLogPage = {
  items: AuditRecord[];
  nextCursor: null | string;
};

export class AuditLogDecodeError extends Error {
  constructor() {
    super('The audit log entry is invalid.');
    this.name = 'AuditLogDecodeError';
  }
}

/**
 * Append-only audit writer for producers that do not need the atomic
 * configuration compare-and-swap. Values are validated and bounded by the
 * shared schemas before they reach D1.
 */
export const appendAuditLog = async (
  environment: Env,
  input: {
    actorUserId: null | string;
    now: Date;
    records: readonly AuditWrite[];
  },
): Promise<void> => {
  if (input.records.length === 0) {
    return;
  }

  await getDatabase(environment)
    .insert(auditLog)
    .values(
      input.records.map((record) => {
        const validated = validateAuditWrite(record);
        return {
          action: validated.action,
          actorUserId: input.actorUserId,
          changesJson: validated.changes,
          createdAt: input.now,
          id: crypto.randomUUID(),
          resourceId: validated.resourceId,
          resourceType: validated.resourceType,
        };
      }),
    );
};

/**
 * Keyset query over the audit log, newest first. Row changes are decoded and
 * validated; a corrupt row fails closed instead of leaking raw JSON.
 */
export const listAuditLog = async (
  environment: Env,
  options: { cursor: Keyset | null; limit: number },
): Promise<AuditLogPage> => {
  const database = getDatabase(environment);
  const keyset =
    options.cursor === null
      ? undefined
      : or(
          lt(auditLog.createdAt, new Date(options.cursor.createdAt)),
          and(
            eq(auditLog.createdAt, new Date(options.cursor.createdAt)),
            lt(auditLog.id, options.cursor.id),
          ),
        );
  let rows: Array<{
    action: string;
    actorUserId: null | string;
    changesJson: readonly AuditChange[];
    createdAt: Date;
    id: string;
    resourceId: null | string;
    resourceType: string;
  }>;
  try {
    rows = await database
      .select({
        action: auditLog.action,
        actorUserId: auditLog.actorUserId,
        changesJson: auditLog.changesJson,
        createdAt: auditLog.createdAt,
        id: auditLog.id,
        resourceId: auditLog.resourceId,
        resourceType: auditLog.resourceType,
      })
      .from(auditLog)
      .where(keyset)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(options.limit + 1);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AuditLogDecodeError();
    }

    throw error;
  }

  const items: AuditRecord[] = rows.slice(0, options.limit).map((row) => {
    const changes: null | readonly AuditChange[] = decodeAuditChanges(
      row.changesJson,
    );
    if (changes === null) {
      throw new AuditLogDecodeError();
    }

    return {
      action: row.action,
      actorUserId: row.actorUserId,
      changes,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
      resourceId: row.resourceId,
      resourceType: row.resourceType,
    };
  });
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > options.limit && last !== undefined
        ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
};
