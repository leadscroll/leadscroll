import { DEFAULT_WORKSPACE_ID, type Env } from '@/db/repository';
import {
  decodeInstallationConfig,
  DEFAULT_INSTALLATION_CONFIG,
  type InstallationConfig,
  type InstallationEmailConfig,
} from '@/domain/schemas';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Shared real-workerd D1 fixture for notification tests. Every fixture starts
 * with a fresh in-memory database and applies the full drizzle/ migration
 * history, so schema behavior is exercised end to end rather than mocked.
 */

export const TEST_ENCRYPTION_KEY = Buffer.from(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
).toString('base64');

export type ConfigSeed = {
  canonicalOrigin?: string;
  credential?: string;
  credentialRemove?: boolean;
  emailTest?: InstallationConfig['emailTest'];
  enabled?: boolean;
  fromEmail?: string;
  fromName?: string;
  provider?: 'cloudflare' | 'disabled' | 'resend';
  revision?: number;
  writeVersion?: number;
};

export type NotificationFixture = {
  count: (table: string) => Promise<number>;
  db: D1Database;
  dispose: () => Promise<void>;
  enableProvider: (input?: ConfigSeed) => Promise<number>;
  env: Env;
  insertCredential: (value: string) => Promise<void>;
  optIn: (userId: string, newLeadEmail?: boolean) => Promise<void>;
  readAuditRows: () => Promise<
    Array<{
      action: string;
      actorUserId: null | string;
      changesJson: string;
      createdAt: Date;
      id: string;
      resourceId: null | string;
      resourceType: string;
    }>
  >;
  readConfig: () => Promise<InstallationConfig>;
  readConfigRow: () => Promise<RawConfigRow>;
  seedLead: (leadId: string, email?: string) => Promise<void>;
  setEmailBinding: (binding: Env['EMAIL']) => void;
  setEncryptionKey: (value: string | undefined) => void;
  setRawConfig: (json: string, writeVersion?: number) => Promise<void>;
  user: (input: {
    disabled?: boolean;
    email: string;
    id: string;
  }) => Promise<string>;
};

export type RawConfigRow = {
  documentJson: string;
  writeVersion: number;
};

const migrationNames = async (): Promise<string[]> =>
  (await readdir(join(process.cwd(), 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

const applyMigrationFile = async (
  database: D1Database,
  name: string,
): Promise<void> => {
  const sql = await readFile(join(process.cwd(), 'drizzle', name), 'utf8');
  for (const statement of sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
};

const applyMigrations = async (database: D1Database): Promise<void> => {
  for (const name of await migrationNames()) {
    await applyMigrationFile(database, name);
  }
};

/**
 * Applies every migration up to and including the one whose name starts with
 * `through`. Used to seed a baseline database before a forward migration and
 * verify that existing rows survive.
 */
export const applyMigrationsThrough = async (
  database: D1Database,
  through: string,
): Promise<void> => {
  for (const name of await migrationNames()) {
    await applyMigrationFile(database, name);
    if (name.startsWith(through)) {
      return;
    }
  }
};

/**
 * Applies every migration whose name sorts at or after `from`.
 */
export const applyMigrationsFrom = async (
  database: D1Database,
  from: string,
): Promise<void> => {
  let started = false;
  for (const name of await migrationNames()) {
    if (name.startsWith(from)) {
      started = true;
    }

    if (started) {
      await applyMigrationFile(database, name);
    }
  }
};

export const startNotificationFixture = async (
  options: { through?: string } = {},
): Promise<NotificationFixture> => {
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      // Miniflare requires a Worker script; notification tests exercise the
      // repository and command layers directly against real D1 instead.
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
    if (options.through === undefined) {
      await applyMigrations(database);
    } else {
      await applyMigrationsThrough(database, options.through);
    }

    const environment = {
      ASSETS: { fetch: async () => new Response('') },
      BETTER_AUTH_SECRET: 'notification-test-secret-12',
      DB: database,
      DEV_ADMIN_EMAIL: 'notify-admin@example.test',
      EMAIL: undefined,
      EMAIL_SETTINGS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      ENVIRONMENT: 'test',
    } as unknown as Env;

    const now = () => Date.now();

    const readConfigRow = async (): Promise<RawConfigRow> => {
      const row = await database
        .prepare(
          'SELECT document_json, write_version FROM installation_config WHERE workspace_id = ?',
        )
        .bind(DEFAULT_WORKSPACE_ID)
        .first<{ document_json: string; write_version: number }>();
      if (row === null) {
        return {
          documentJson: JSON.stringify(DEFAULT_INSTALLATION_CONFIG),
          writeVersion: 0,
        };
      }

      return {
        documentJson: row.document_json,
        writeVersion: Number(row.write_version),
      };
    };

    const writeDocument = async (
      document: InstallationConfig,
      writeVersion: number,
    ): Promise<void> => {
      await database
        .prepare(
          `INSERT INTO installation_config (
            workspace_id, document_json, write_version, updated_at, updated_by_user_id
          ) VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT(workspace_id) DO UPDATE SET
            document_json = excluded.document_json,
            write_version = excluded.write_version,
            updated_at = excluded.updated_at`,
        )
        .bind(
          DEFAULT_WORKSPACE_ID,
          JSON.stringify(document),
          writeVersion,
          now(),
        )
        .run();
    };

    const applySeed = async (input: ConfigSeed = {}) => {
      const row = await readConfigRow();
      const current =
        decodeInstallationConfig(row.documentJson) ??
        DEFAULT_INSTALLATION_CONFIG;
      let credential = current.email.credential;
      if (input.credentialRemove === true) {
        credential = null;
      } else if (input.credential !== undefined) {
        const { encryptCredential } =
          await import('@/notifications/credential-crypto');
        credential = await encryptCredential(TEST_ENCRYPTION_KEY, {
          provider: 'resend',
          value: input.credential,
          workspaceId: DEFAULT_WORKSPACE_ID,
        });
      }

      const email: InstallationEmailConfig = {
        canonicalOrigin: input.canonicalOrigin ?? 'https://crm.example.test',
        credential,
        enabled: input.enabled ?? true,
        fromEmail: input.fromEmail ?? 'notifications@example.test',
        fromName: input.fromName ?? 'LeadScroll',
        provider: input.provider ?? 'cloudflare',
      };
      const document: InstallationConfig = {
        ...current,
        email,
        emailTest: input.emailTest ?? current.emailTest,
        revision: input.revision ?? Math.max(current.revision, 1),
      };
      await writeDocument(document, input.writeVersion ?? row.writeVersion + 1);
      return document.revision;
    };

    return {
      count: async (table) => {
        const row = await database
          .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
          .first<{ total: number }>();
        return Number(row?.total ?? 0);
      },
      db: database,
      dispose,
      enableProvider: applySeed,
      env: environment,
      insertCredential: async (value) => {
        const row = await readConfigRow();
        const current =
          decodeInstallationConfig(row.documentJson) ??
          DEFAULT_INSTALLATION_CONFIG;
        const { encryptCredential } =
          await import('@/notifications/credential-crypto');
        const credential = await encryptCredential(TEST_ENCRYPTION_KEY, {
          provider: 'resend',
          value,
          workspaceId: DEFAULT_WORKSPACE_ID,
        });
        await writeDocument(
          { ...current, email: { ...current.email, credential } },
          row.writeVersion + 1,
        );
      },
      optIn: async (userId, newLeadEmail = true) => {
        await database
          .prepare(
            `INSERT INTO notification_preferences (workspace_id, user_id, new_lead_email, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                new_lead_email = excluded.new_lead_email,
                updated_at = excluded.updated_at`,
          )
          .bind(DEFAULT_WORKSPACE_ID, userId, newLeadEmail ? 1 : 0, now())
          .run();
      },
      readAuditRows: async () => {
        const rows = await database
          .prepare(
            `SELECT id, action, actor_user_id, changes_json, resource_type,
                    resource_id, created_at
             FROM audit_log WHERE workspace_id = ?
             ORDER BY created_at ASC, id ASC`,
          )
          .bind(DEFAULT_WORKSPACE_ID)
          .all<{
            action: string;
            actor_user_id: null | string;
            changes_json: string;
            created_at: number;
            id: string;
            resource_id: null | string;
            resource_type: string;
          }>();
        return rows.results.map((row) => ({
          action: row.action,
          actorUserId: row.actor_user_id,
          changesJson: row.changes_json,
          createdAt: new Date(Number(row.created_at)),
          id: row.id,
          resourceId: row.resource_id,
          resourceType: row.resource_type,
        }));
      },
      readConfig: async () => {
        const row = await readConfigRow();
        const document = decodeInstallationConfig(row.documentJson);
        if (document === null) {
          throw new Error('The fixture configuration is invalid.');
        }

        return document;
      },
      readConfigRow,
      seedLead: async (leadId, email = 'lead@example.test') => {
        await database
          .prepare(
            `INSERT INTO leads (
              id, workspace_id, source, custom_fields, email, created_at,
              updated_at, deleted_at
            ) VALUES (?, ?, 'Test', '{}', ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
              email = excluded.email,
              updated_at = excluded.updated_at,
              deleted_at = NULL`,
          )
          .bind(leadId, DEFAULT_WORKSPACE_ID, email, now(), now())
          .run();
      },
      setEmailBinding: (binding) => {
        environment.EMAIL = binding;
      },
      setEncryptionKey: (value) => {
        environment.EMAIL_SETTINGS_ENCRYPTION_KEY = value;
      },
      setRawConfig: async (json, writeVersion = 1) => {
        await database
          .prepare(
            `INSERT INTO installation_config (
              workspace_id, document_json, write_version, updated_at, updated_by_user_id
            ) VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(workspace_id) DO UPDATE SET
              document_json = excluded.document_json,
              write_version = excluded.write_version,
              updated_at = excluded.updated_at`,
          )
          .bind(DEFAULT_WORKSPACE_ID, json, writeVersion, now())
          .run();
      },
      user: async (input) => {
        await database
          .prepare(
            `INSERT INTO user (
              id, name, email, email_verified, created_at, updated_at,
              disabled_at
            ) VALUES (?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              email = excluded.email,
              name = excluded.name,
              updated_at = excluded.updated_at,
              disabled_at = excluded.disabled_at`,
          )
          .bind(
            input.id,
            input.email,
            input.email,
            now(),
            now(),
            input.disabled ? now() : null,
          )
          .run();
        return input.id;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};
