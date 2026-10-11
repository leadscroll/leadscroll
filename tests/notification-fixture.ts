import { DEFAULT_WORKSPACE_ID, type Env } from '@/db/repository';
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

export type NotificationFixture = {
  count: (table: string) => Promise<number>;
  db: D1Database;
  dispose: () => Promise<void>;
  enableProvider: (input?: {
    enabled?: boolean;
    fromEmail?: string;
    fromName?: string;
    pausedReasonCode?: string;
    pausedRevision?: number;
    provider?: 'cloudflare' | 'disabled' | 'resend';
    revision?: number;
  }) => Promise<number>;
  env: Env;
  insertCredential: (value: string) => Promise<void>;
  insertOutbox: (
    input: Record<string, unknown> & { id: string; leadId: string },
  ) => Promise<void>;
  optIn: (userId: string, newLeadEmail?: boolean) => Promise<void>;
  readOutbox: (id: string) => Promise<Record<string, unknown> | undefined>;
  seedLead: (leadId: string, email?: string) => Promise<void>;
  setEmailBinding: (binding: Env['EMAIL']) => void;
  setEncryptionKey: (value: string | undefined) => void;
  user: (input: {
    disabled?: boolean;
    email: string;
    id: string;
  }) => Promise<string>;
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
 * `through`. Used to seed a baseline database before an additive migration and
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

    const insert = async (
      table: string,
      input: Record<string, unknown>,
    ): Promise<void> => {
      const columns = Object.keys(input).filter(
        (column) => input[column] !== undefined,
      );
      await database
        .prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
            .map(() => '?')
            .join(', ')})`,
        )
        .bind(...columns.map((column) => input[column] as never))
        .run();
    };

    const now = () => Date.now();
    return {
      count: async (table) => {
        const row = await database
          .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
          .first<{ total: number }>();
        return Number(row?.total ?? 0);
      },
      db: database,
      dispose,
      enableProvider: async (input = {}) => {
        const revision = input.revision ?? 1;
        await database
          .prepare(
            `INSERT INTO email_settings (
              workspace_id, provider, enabled, from_email, from_name,
              canonical_origin, revision, paused_revision, paused_reason_code,
              paused_at, updated_by_user_id, updated_at, write_token
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
              provider = excluded.provider,
              enabled = excluded.enabled,
              from_email = excluded.from_email,
              from_name = excluded.from_name,
              canonical_origin = excluded.canonical_origin,
              revision = excluded.revision,
              paused_revision = excluded.paused_revision,
              paused_reason_code = excluded.paused_reason_code,
              paused_at = excluded.paused_at,
              updated_at = excluded.updated_at,
              write_token = excluded.write_token`,
          )
          .bind(
            DEFAULT_WORKSPACE_ID,
            input.provider ?? 'cloudflare',
            input.enabled === false ? 0 : 1,
            input.fromEmail ?? 'notifications@example.test',
            input.fromName ?? 'LeadScroll',
            'https://crm.example.test',
            revision,
            input.pausedReasonCode ? revision : null,
            input.pausedReasonCode ?? null,
            input.pausedReasonCode ? now() : null,
            now(),
            `seed-${revision}`,
          )
          .run();
        return revision;
      },
      env: environment,
      insertCredential: async (value) => {
        const { encryptCredential } =
          await import('@/notifications/credential-crypto');
        const envelope = await encryptCredential(TEST_ENCRYPTION_KEY, {
          provider: 'resend',
          value,
          workspaceId: DEFAULT_WORKSPACE_ID,
        });
        await insert('email_credentials', {
          ciphertext: envelope.ciphertext,
          key_version: envelope.keyVersion,
          nonce: envelope.nonce,
          provider: 'resend',
          updated_at: now(),
          updated_by_user_id: null,
          workspace_id: DEFAULT_WORKSPACE_ID,
        });
      },
      insertOutbox: async (input) => {
        const { leadId, ...overrides } = input;
        const resolvedLeadId =
          typeof leadId === 'string'
            ? leadId
            : (overrides.lead_id as string | undefined);
        if (resolvedLeadId === undefined) {
          throw new Error('insertOutbox requires a leadId');
        }

        await insert('notification_outbox', {
          attempt_count: 0,
          config_revision: null,
          created_at: now(),
          delivery_key: null,
          event_key:
            typeof overrides.event_key === 'string'
              ? overrides.event_key
              : `lead.created:${resolvedLeadId}:${String(overrides.id ?? '')}`,
          event_kind: 'lead.created',
          first_attempt_at: null,
          frozen_envelope_json: null,
          idempotency_deadline: null,
          lead_id: resolvedLeadId,
          lease_expires_at: null,
          lease_token: null,
          next_attempt_at: now(),
          payload_hash: null,
          provider: null,
          provider_message_id: null,
          reason_code: null,
          recipient_email: 'staff@example.test',
          recipient_user_id: null,
          status: 'pending',
          template_version: 1,
          updated_at: now(),
          workspace_id: DEFAULT_WORKSPACE_ID,
          ...overrides,
        });
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
      readOutbox: async (id) =>
        (await database
          .prepare('SELECT * FROM notification_outbox WHERE id = ?')
          .bind(id)
          .first()) ?? undefined,
      seedLead: async (leadId, email = 'lead@example.test') => {
        await insert('leads', {
          created_at: now(),
          custom_fields: '{}',
          email,
          id: leadId,
          source: 'Test',
          updated_at: now(),
          workspace_id: DEFAULT_WORKSPACE_ID,
        });
      },
      setEmailBinding: (binding) => {
        environment.EMAIL = binding;
      },
      setEncryptionKey: (value) => {
        environment.EMAIL_SETTINGS_ENCRYPTION_KEY = value;
      },
      user: async (input) => {
        await insert('user', {
          created_at: now(),
          disabled_at: input.disabled ? now() : null,
          email: input.email,
          email_verified: 0,
          id: input.id,
          name: input.email,
          updated_at: now(),
        });
        return input.id;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};
