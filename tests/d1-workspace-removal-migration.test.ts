import {
  LEGACY_CREDENTIAL_ENVELOPE,
  LEGACY_CREDENTIAL_KEY,
  LEGACY_CREDENTIAL_PLAINTEXT,
} from './credential-ciphertext.fixture';
import {
  type Env,
  getIntakeKey,
  getLead,
  isIntakeToken,
  listAuditLog,
  listLeadActivities,
  listLeadCreatedRecipients,
  listTagCatalog,
  readInstallationConfig,
} from '@/db/repository';
import {
  decodeInstallationConfig,
  DEFAULT_INSTALLATION_CONFIG,
} from '@/domain/schemas';
import { decryptCredential } from '@/notifications/credential-crypto';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * Migration 0005 removes the historical singleton workspace entity.
 *
 * The fixture applies each published migration file as one D1 batch, exactly
 * like `wrangler d1 migrations apply` (Wrangler splits the file and sends the
 * statements through `D1Database.batch`, so one file is one transaction). That
 * makes the refusal assertions meaningful: a preflight failure must roll back
 * the whole file with no partially rebuilt tables.
 */

const repoRoot = process.cwd();
const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const USER_ID = 'migration-user';
const OTHER_USER_ID = 'migration-other-user';
const LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const OTHER_LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const RAW_TOKEN = 'lsc_migration_token';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const NOW = Date.parse('2026-10-17T00:00:00.000Z');

type Fixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  env: Env;
};

type Row = Record<string, unknown>;

const splitStatements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter(Boolean);

const startD1 = async (): Promise<Fixture> => {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script:
        'export default { async fetch() { return new Response("ok"); } };',
    }),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }

    disposed = true;
    await miniflare.dispose();
  };

  try {
    const database = await miniflare.getD1Database('DB');
    return {
      db: database,
      dispose,
      env: {
        ASSETS: { fetch: async () => new Response('') },
        BETTER_AUTH_SECRET: 'migration-test-secret-12',
        DB: database,
        EMAIL_SETTINGS_ENCRYPTION_KEY: LEGACY_CREDENTIAL_KEY,
        ENVIRONMENT: 'test',
      } as unknown as Env,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (value) => value.dispose()));
});

const fixture = async (): Promise<Fixture> => {
  const value = await startD1();
  fixtures.push(value);
  return value;
};

const migrationNames = async (): Promise<string[]> =>
  (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

/**
 * Mirrors Wrangler's local migration execution: every statement plus the
 * `d1_migrations` receipt is one atomic D1 batch.
 */
const applyMigration = async (
  database: D1Database,
  name: string,
): Promise<void> => {
  const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
  const statements = splitStatements(sql);
  statements.push(
    `INSERT INTO d1_migrations (name) VALUES ('${name.replaceAll("'", "''")}')`,
  );
  await database.batch(
    statements.map((statement) => database.prepare(statement)),
  );
};

const applyThrough = async (
  database: D1Database,
  through: string,
): Promise<void> => {
  await database
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`,
    )
    .run();
  for (const name of await migrationNames()) {
    await applyMigration(database, name);
    if (name.startsWith(through)) {
      return;
    }
  }
};

const applyAll = async (database: D1Database): Promise<void> => {
  await applyThrough(database, '9999');
};

const rows = async (
  database: D1Database,
  query: string,
  ...binds: unknown[]
): Promise<Row[]> => {
  const result = await database
    .prepare(query)
    .bind(...binds)
    .all<Row>();
  return result.results;
};

const tableNames = async (database: D1Database): Promise<string[]> =>
  (
    await rows(
      database,
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
  ).map((row) => String(row.name));

const tableColumns = async (
  database: D1Database,
  table: string,
): Promise<string[]> =>
  (await rows(database, `PRAGMA table_info("${table}")`)).map((row) =>
    String(row.name),
  );

const stable = (row: Row): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );

const sortedRows = (values: Row[]): string[] =>
  values.map((row) => stable(row)).toSorted();

const snapshot = async (
  database: D1Database,
): Promise<Record<string, Row[]>> => {
  const names = await tableNames(database);
  const entries = await Promise.all(
    names
      .filter((name) => name !== 'd1_migrations')
      .map(
        async (name) =>
          [name, await rows(database, `SELECT * FROM "${name}"`)] as const,
      ),
  );
  return Object.fromEntries(entries);
};

const omit = (row: Row, key: string): Row =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));

const seedUser = async (
  database: D1Database,
  id: string,
  email: string,
): Promise<void> => {
  await database
    .prepare(
      `INSERT INTO user (
        id, name, email, email_verified, created_at, updated_at, disabled_at
      ) VALUES (?, ?, ?, 0, ?, ?, NULL)`,
    )
    .bind(id, `Migration ${id}`, email, NOW, NOW)
    .run();
};

const seedWorkspaceData = async (
  database: D1Database,
  input: {
    leadId: string;
    rawToken: string;
    tokenId: string;
    userId: string;
    workspaceId: string;
  },
): Promise<void> => {
  const { leadId, rawToken, tokenId, userId, workspaceId } = input;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const scopeId = `${leadId}-scope`;
  const tagId = `${leadId}-tag`;
  await database
    .prepare(
      `INSERT INTO leads (
        id, workspace_id, email, first_name, last_name, source,
        estimated_value, custom_fields, raw_payload, skipped_fields, origin,
        token_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, 'Migration', 'Lead', 'website', 4200, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      leadId,
      workspaceId,
      `${leadId}@example.test`,
      JSON.stringify({ plan: 'pro' }),
      JSON.stringify({ email: `${leadId}@example.test` }),
      JSON.stringify([{ name: 'secret', reason: 'unmarked' }]),
      'https://example.test/form',
      tokenId,
      NOW,
      NOW,
    )
    .run();
  await database
    .prepare(
      `INSERT INTO tag_scopes (id, workspace_id, prefix, color, created_at, updated_at)
       VALUES (?, ?, 'source', 'teal', ?, ?)`,
    )
    .bind(scopeId, workspaceId, NOW, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO tags (id, workspace_id, name, scope_id, color, created_at, updated_at)
       VALUES (?, ?, 'website', ?, NULL, ?, ?)`,
    )
    .bind(tagId, workspaceId, scopeId, NOW, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO lead_tags (id, workspace_id, lead_id, tag_id, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(`${leadId}-assignment`, workspaceId, leadId, tagId, scopeId, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO activities (id, workspace_id, lead_id, kind, body, metadata, actor_email, created_at)
       VALUES (?, ?, ?, 'intake', 'Received from website', '{}', NULL, ?)`,
    )
    .bind(`${leadId}-activity`, workspaceId, leadId, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO api_tokens (id, workspace_id, name, prefix, scope, type, token, token_hash, created_at, expires_at, revoked_at)
       VALUES (?, ?, 'Migration', 'lsc_migrati', 'intake:write', 'api', NULL, ?, ?, NULL, NULL)`,
    )
    .bind(tokenId, workspaceId, tokenHash, NOW)
    .run();
  await database
    .prepare(
      `INSERT INTO idempotency_keys (workspace_id, key, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      workspaceId,
      `${leadId}-idempotency`,
      'a'.repeat(64),
      JSON.stringify({ created: true, leadId }),
      NOW,
    )
    .run();
  await database
    .prepare(
      `INSERT INTO notification_preferences (workspace_id, user_id, new_lead_email, updated_at)
       VALUES (?, ?, 1, ?)`,
    )
    .bind(workspaceId, userId, NOW)
    .run();
};

const seedPopulatedDatabase = async (database: D1Database): Promise<void> => {
  await seedUser(database, USER_ID, 'migration@example.test');
  await seedUser(database, OTHER_USER_ID, 'migration-other@example.test');
  await database
    .prepare(
      `INSERT INTO session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
       VALUES ('migration-session', ?, 'migration-session-token', ?, ?, '127.0.0.1', 'vitest', ?)`,
    )
    .bind(NOW + 86_400_000, NOW, NOW, USER_ID)
    .run();
  await database
    .prepare(
      `INSERT INTO staff_invites (id, name, prefix, token_hash, created_at, expires_at, revoked_at, used_at, used_by_user_id)
       VALUES ('migration-invite', 'Migration invite', 'lsc_migrati', ?, ?, ?, NULL, NULL, NULL)`,
    )
    .bind(`invite-${'b'.repeat(64)}`, NOW, NOW + 86_400_000)
    .run();
  await database
    .prepare(
      `INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at)
       VALUES ('migration-claim', 'invite', ?, 'migration-claim', ?, ?)`,
    )
    .bind(`invite-${'b'.repeat(64)}`, USER_ID, NOW)
    .run();
  await seedWorkspaceData(database, {
    leadId: LEAD_ID,
    rawToken: RAW_TOKEN,
    tokenId: 'migration-token',
    userId: USER_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
  });
  await database
    .prepare(
      `INSERT INTO installation_config (workspace_id, document_json, write_version, write_token)
       VALUES (?, ?, 7, 'migration-write-token')`,
    )
    .bind(
      DEFAULT_WORKSPACE_ID,
      JSON.stringify({
        ...DEFAULT_INSTALLATION_CONFIG,
        email: {
          ...DEFAULT_INSTALLATION_CONFIG.email,
          credential: LEGACY_CREDENTIAL_ENVELOPE,
          enabled: true,
          fromEmail: 'alerts@example.test',
          provider: 'resend',
        },
        revision: 4,
      }),
    )
    .run();
  await database
    .prepare(
      `INSERT INTO audit_log (id, workspace_id, actor_user_id, changes_json, created_at, action, resource_id, resource_type)
       VALUES ('migration-audit', ?, ?, ?, ?, 'email.settings_updated', NULL, 'installation.email')`,
    )
    .bind(
      DEFAULT_WORKSPACE_ID,
      USER_ID,
      JSON.stringify([
        { after: 'resend', before: 'disabled', field: 'email.provider' },
      ]),
      NOW,
    )
    .run();
};

describe('workspace removal migration', () => {
  test('fresh install applies every migration into the installation model', async () => {
    const fx = await fixture();
    await applyAll(fx.db);

    const names = await tableNames(fx.db);
    expect(names).not.toContain('workspaces');
    expect(names).toEqual(
      expect.arrayContaining([
        'activities',
        'api_tokens',
        'audit_log',
        'idempotency_keys',
        'installation_config',
        'lead_tags',
        'leads',
        'notification_preferences',
        'tag_scopes',
        'tags',
      ]),
    );

    for (const table of [
      'activities',
      'api_tokens',
      'audit_log',
      'idempotency_keys',
      'installation_config',
      'lead_tags',
      'leads',
      'notification_preferences',
      'tag_scopes',
      'tags',
    ]) {
      expect(await tableColumns(fx.db, table)).not.toContain('workspace_id');
    }

    expect(await rows(fx.db, 'PRAGMA foreign_key_check')).toEqual([]);

    await expect(
      fx.db
        .prepare(
          `INSERT INTO installation_config (id, document_json, write_version, write_token)
           VALUES ('not-the-singleton', '{}', 1, NULL)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/iu);
  });

  test('populated upgrade preserves every row, id, constraint and setting', async () => {
    const fx = await fixture();
    await applyThrough(fx.db, '0004');
    await seedPopulatedDatabase(fx.db);

    const before = await snapshot(fx.db);
    expect(before.workspaces).toHaveLength(1);
    const configBefore = before.installation_config?.[0];
    expect(configBefore).toBeDefined();
    const configDocument = String(configBefore?.document_json);

    await applyMigration(fx.db, '0005_remove_workspaces.sql');

    const after = await snapshot(fx.db);
    expect(after.workspaces).toBeUndefined();
    for (const [table, tableRows] of Object.entries(before)) {
      if (table === 'workspaces') {
        continue;
      }

      if (table === 'installation_config') {
        expect(sortedRows(after[table] ?? [])).toEqual(
          sortedRows(
            tableRows.map((row) => ({
              ...omit(row, 'workspace_id'),
              id: 'installation',
            })),
          ),
        );
        continue;
      }

      expect(sortedRows(after[table] ?? [])).toEqual(
        sortedRows(tableRows.map((row) => omit(row, 'workspace_id'))),
      );
    }

    // The singleton check, per-user preference key and installation-wide
    // uniqueness constraints are real database constraints, not application
    // conventions.
    await expect(
      fx.db
        .prepare(
          `INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at)
           VALUES ('duplicate-scope', 'source', 'teal', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await expect(
      fx.db
        .prepare(
          `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
           VALUES ('duplicate-tag', 'website', ?, NULL, ?, ?)`,
        )
        .bind(`${LEAD_ID}-scope`, NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await fx.db
      .prepare(
        `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
         VALUES ('standalone-tag', 'standalone', NULL, 'teal', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await expect(
      fx.db
        .prepare(
          `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
           VALUES ('duplicate-standalone', 'standalone', NULL, 'teal', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await fx.db
      .prepare(
        `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
         VALUES ('second-scoped-tag', 'referral', ?, NULL, ?, ?)`,
      )
      .bind(`${LEAD_ID}-scope`, NOW, NOW)
      .run();
    await expect(
      fx.db
        .prepare(
          `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
           VALUES ('duplicate-assignment', ?, 'second-scoped-tag', ?, ?)`,
        )
        .bind(LEAD_ID, `${LEAD_ID}-scope`, NOW)
        .run(),
    ).rejects.toThrow();
    await expect(
      fx.db
        .prepare(
          `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at)
           VALUES (?, ?, '{}', ?)`,
        )
        .bind(`${LEAD_ID}-idempotency`, 'c'.repeat(64), NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await expect(
      fx.db
        .prepare(
          `INSERT INTO notification_preferences (user_id, new_lead_email, updated_at)
           VALUES (?, 0, ?)`,
        )
        .bind(USER_ID, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await expect(
      fx.db
        .prepare(
          `INSERT INTO installation_config (id, document_json, write_version, write_token)
           VALUES ('installation', '{}', 1, NULL)`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);
    await expect(
      fx.db
        .prepare(
          `INSERT INTO installation_config (id, document_json, write_version, write_token)
           VALUES ('other', '{}', 1, NULL)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/iu);
    await expect(
      fx.db
        .prepare(
          `INSERT INTO api_tokens (id, name, prefix, scope, type, token_hash, created_at)
           VALUES ('duplicate-token', 'Duplicate', 'lsc_dup', 'intake:write', 'api', ?, ?)`,
        )
        .bind(TOKEN_HASH, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/iu);

    expect(await rows(fx.db, 'PRAGMA foreign_key_check')).toEqual([]);

    // Runtime reads through the new schema still see the same data.
    await expect(isIntakeToken(fx.env, RAW_TOKEN)).resolves.toEqual({
      id: 'migration-token',
    });
    await expect(
      getIntakeKey(fx.env, `${LEAD_ID}-idempotency`),
    ).resolves.toEqual({
      requestHash: 'a'.repeat(64),
      responseJson: { created: true, leadId: LEAD_ID },
    });
    const lead = await getLead(fx.env, LEAD_ID);
    expect(lead).toMatchObject({
      email: `${LEAD_ID}@example.test`,
      estimatedValue: 4_200,
      firstName: 'Migration',
      id: LEAD_ID,
      source: 'website',
    });
    expect(lead?.tags.map((tag) => tag.label)).toEqual(['source:website']);
    const activities = await listLeadActivities(fx.env, LEAD_ID);
    expect(activities.map((activity) => activity.id)).toEqual([
      `${LEAD_ID}-activity`,
    ]);
    const catalog = await listTagCatalog(fx.env);
    expect(catalog.scopes.map((scope) => scope.prefix)).toEqual(['source']);
    expect(
      catalog.tags.find((tag) => tag.label === 'source:website'),
    ).toMatchObject({ label: 'source:website', leadCount: 1 });
    const config = await readInstallationConfig(fx.env);
    expect(config.writeVersion).toBe(7);
    expect(decodeInstallationConfig(config.document)?.revision).toBe(4);
    const credential = config.document.email.credential;
    expect(credential).not.toBeNull();
    if (credential === null) {
      throw new Error('The migrated credential envelope is missing.');
    }

    await expect(
      decryptCredential(LEGACY_CREDENTIAL_KEY, {
        envelope: credential,
        provider: 'resend',
      }),
    ).resolves.toBe(LEGACY_CREDENTIAL_PLAINTEXT);
    expect(JSON.parse(configDocument)).toMatchObject({ revision: 4 });

    const audit = await listAuditLog(fx.env, { cursor: null, limit: 10 });
    expect(audit.items.map((item) => item.action)).toEqual([
      'email.settings_updated',
    ]);
    await expect(listLeadCreatedRecipients(fx.env, null)).resolves.toEqual([
      { email: 'migration@example.test', userId: USER_ID },
    ]);
  });

  test('refuses unexpected non-default workspace data atomically', async () => {
    const fx = await fixture();
    await applyThrough(fx.db, '0004');
    await seedPopulatedDatabase(fx.db);

    // A manual edit created a second workspace and rows in every scoped
    // table. The migration must not merge, drop or normalize any of it.
    await fx.db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES (?, 'Second workspace', 'second', ?, ?)`,
      )
      .bind(OTHER_WORKSPACE_ID, NOW, NOW)
      .run();
    await seedWorkspaceData(fx.db, {
      leadId: OTHER_LEAD_ID,
      rawToken: 'lsc_migration_other_token',
      tokenId: 'migration-other-token',
      userId: OTHER_USER_ID,
      workspaceId: OTHER_WORKSPACE_ID,
    });
    await fx.db
      .prepare(
        `INSERT INTO installation_config (workspace_id, document_json, write_version, write_token)
         VALUES (?, '{}', 3, 'other-write-token')`,
      )
      .bind(OTHER_WORKSPACE_ID)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_user_id, changes_json, created_at, action, resource_id, resource_type)
         VALUES ('other-audit', ?, NULL, '[]', ?, 'email.settings_updated', NULL, 'installation.email')`,
      )
      .bind(OTHER_WORKSPACE_ID, NOW)
      .run();

    const before = await snapshot(fx.db);
    const migrationsBefore = await rows(
      fx.db,
      'SELECT name FROM d1_migrations ORDER BY name',
    );

    await expect(
      applyMigration(fx.db, '0005_remove_workspaces.sql'),
    ).rejects.toThrow(/workspace_removal_refused_non_default_/u);

    // One batch is one transaction: no guard table, no temporary tables, no
    // dropped columns, no changed rows and no migration receipt survive.
    expect(await snapshot(fx.db)).toEqual(before);
    expect(
      await rows(fx.db, 'SELECT name FROM d1_migrations ORDER BY name'),
    ).toEqual(migrationsBefore);
    const names = await tableNames(fx.db);
    expect(names).toContain('workspaces');
    expect(names).not.toContain('__workspace_removal_preflight');
    expect(names.filter((name) => name.startsWith('__new_'))).toEqual([]);
    for (const table of [
      'activities',
      'api_tokens',
      'audit_log',
      'idempotency_keys',
      'installation_config',
      'lead_tags',
      'leads',
      'notification_preferences',
      'tag_scopes',
      'tags',
    ]) {
      expect(await tableColumns(fx.db, table)).toContain('workspace_id');
    }

    expect(await rows(fx.db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
