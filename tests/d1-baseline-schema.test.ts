import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * The squashed baseline is the only migration in this epoch. These tests apply
 * it exactly as Wrangler does (one D1 batch) and verify the final installation
 * schema, the hand-written bootstrap seed and grant trigger, and the database
 * constraints that the application relies on.
 */

const repoRoot = process.cwd();
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-17T00:00:00.000Z');

type Fixture = {
  database: D1Database;
  dispose: () => Promise<void>;
};

type Row = Record<string, unknown>;

const splitStatements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter(Boolean);

const migrationNames = async (): Promise<string[]> =>
  (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

const applyBaseline = async (database: D1Database): Promise<void> => {
  for (const name of await migrationNames()) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    await database.batch(
      splitStatements(sql).map((statement) => database.prepare(statement)),
    );
  }
};

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
    await applyBaseline(database);
    return { database, dispose };
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

const allRows = async (
  database: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Row[]> => {
  const result = await database
    .prepare(sql)
    .bind(...binds)
    .all<Row>();
  return result.results;
};

const singleRow = async (
  database: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Row> => {
  const row = await database
    .prepare(sql)
    .bind(...binds)
    .first<Row>();
  if (row === null) {
    throw new Error(`no row for: ${sql}`);
  }

  return row;
};

const tableNames = async (database: D1Database): Promise<string[]> =>
  (
    await allRows(
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
  (await allRows(database, `PRAGMA table_info("${table}")`)).map((row) =>
    String(row.name),
  );

describe('squashed baseline schema', () => {
  test('is the only migration and creates the final installation schema', async () => {
    expect(await migrationNames()).toEqual(['0000_leadscroll_baseline.sql']);
    const { database } = await fixture();

    expect(await tableNames(database)).toEqual([
      'account',
      'activities',
      'api_tokens',
      'audit_log',
      'bootstrap_state',
      'idempotency_keys',
      'installation_config',
      'lead_tags',
      'leads',
      'notification_preferences',
      'rate_limit',
      'registration_claims',
      'session',
      'staff_invites',
      'tag_scopes',
      'tags',
      'user',
      'verification',
    ]);

    expect(await tableNames(database)).not.toContain('workspaces');
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
      expect(await tableColumns(database, table)).not.toContain('workspace_id');
    }

    expect(await allRows(database, 'PRAGMA foreign_key_check')).toEqual([]);

    // The hand-written guard trigger and bootstrap seed are part of the
    // baseline even though drizzle-kit does not model them.
    const trigger = await singleRow(
      database,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'registration_claims_grant_guard'",
    );
    expect(String(trigger.sql)).toContain('RAISE(ABORT');
    const bootstrap = await singleRow(
      database,
      "SELECT * FROM bootstrap_state WHERE id = 'default'",
    );
    expect(bootstrap).toMatchObject({ consumed_at: null, id: 'default' });
    expect(
      Math.abs(
        Number(bootstrap.expires_at) -
          Number(bootstrap.created_at) -
          7 * DAY_MS,
      ),
    ).toBeLessThanOrEqual(1_000);
    expect(
      await allRows(database, 'SELECT COUNT(*) AS total FROM bootstrap_state'),
    ).toEqual([{ total: 1 }]);
  });

  test('preserves installation-wide uniqueness and exclusivity constraints', async () => {
    const { database } = await fixture();
    await database
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-1', 'User', 'user@example.test', 1, ?, ?)",
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO leads (id, email, source, custom_fields, created_at, updated_at)
         VALUES ('lead-1', 'lead@example.test', 'website', '{}', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at)
         VALUES ('scope-1', 'source', 'teal', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
         VALUES ('tag-1', 'website', 'scope-1', NULL, ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
         VALUES ('assignment-1', 'lead-1', 'tag-1', 'scope-1', ?)`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO api_tokens (id, name, prefix, scope, type, token_hash, created_at)
         VALUES ('token-1', 'Token', 'lsc_test', 'intake:write', 'api', 'hash-1', ?)`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at)
         VALUES ('idem-1', 'request-hash', '{}', ?)`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO notification_preferences (user_id, new_lead_email, updated_at)
         VALUES ('user-1', 1, ?)`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(
        `INSERT INTO installation_config (id, document_json, write_version, write_token)
         VALUES ('installation', '{}', 1, 'write-token')`,
      )
      .run();

    await expect(
      database
        .prepare(
          `INSERT INTO tag_scopes (id, prefix, color, created_at, updated_at)
           VALUES ('scope-2', 'source', 'teal', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
           VALUES ('tag-2', 'website', 'scope-1', NULL, ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await database
      .prepare(
        `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
         VALUES ('tag-2', 'referral', 'scope-1', NULL, ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await expect(
      database
        .prepare(
          `INSERT INTO lead_tags (id, lead_id, tag_id, scope_id, created_at)
           VALUES ('assignment-2', 'lead-1', 'tag-2', 'scope-1', ?)`,
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await database
      .prepare(
        `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
         VALUES ('tag-3', 'standalone', NULL, 'teal', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await expect(
      database
        .prepare(
          `INSERT INTO tags (id, name, scope_id, color, created_at, updated_at)
           VALUES ('tag-4', 'standalone', NULL, 'teal', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at)
           VALUES ('idem-1', 'other-hash', '{}', ?)`,
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO notification_preferences (user_id, new_lead_email, updated_at)
           VALUES ('user-1', 0, ?)`,
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO installation_config (id, document_json, write_version, write_token)
           VALUES ('other', '{}', 1, NULL)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO installation_config (id, document_json, write_version, write_token)
           VALUES ('installation', '{}', 1, NULL)`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      database
        .prepare(
          `INSERT INTO api_tokens (id, name, prefix, scope, type, token_hash, created_at)
           VALUES ('token-2', 'Duplicate', 'lsc_dupe', 'intake:write', 'api', 'hash-1', ?)`,
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/u);

    expect(await allRows(database, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('baseline trigger protects bootstrap and invite grants', async () => {
    const { database } = await fixture();
    const insertClaim = (
      id: string,
      claimKey: string,
      kind: string,
      reference: string,
    ) =>
      database
        .prepare(
          'INSERT INTO registration_claims (id, claim_key, grant_kind, grant_ref, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, claimKey, kind, reference, NOW)
        .run();

    // The seeded bootstrap grant allows one claim, and the unique claim_key
    // prevents a second redemption of the same grant.
    await insertClaim('claim-1', 'bootstrap', 'bootstrap', 'bootstrap');
    await expect(
      insertClaim('claim-2', 'bootstrap', 'bootstrap', 'bootstrap'),
    ).rejects.toThrow(/UNIQUE constraint failed/u);

    // Consuming the bootstrap state closes the grant permanently.
    await database
      .prepare(
        "UPDATE bootstrap_state SET consumed_at = ? WHERE id = 'default'",
      )
      .bind(NOW)
      .run();
    await expect(
      insertClaim('claim-3', 'bootstrap-2', 'bootstrap', 'bootstrap'),
    ).rejects.toThrow(/registration grant unavailable/u);

    // Invite claims require a live, matching staff-invite hash.
    await database
      .prepare(
        `INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at)
         VALUES ('invite-1', 'Invite', 'live-hash', 'lsc_inv', ?, ?)`,
      )
      .bind(NOW, NOW + DAY_MS)
      .run();
    await insertClaim('claim-4', 'invite-1', 'invite', 'live-hash');
    await database
      .prepare("UPDATE staff_invites SET revoked_at = ? WHERE id = 'invite-1'")
      .bind(NOW)
      .run();
    await expect(
      insertClaim('claim-5', 'invite-2', 'invite', 'live-hash'),
    ).rejects.toThrow(/registration grant unavailable/u);
  });
});
