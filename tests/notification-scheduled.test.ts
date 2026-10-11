import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * Exercises the actual scheduled export in workerd. The handler must run
 * through Miniflare's local scheduled endpoint, record health, and leave the
 * HTTP path untouched — a generated-wrapper regression here would silently
 * stop installed notifications.
 */

const repoRoot = process.cwd();
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const fixtures: Array<{ dispose: () => Promise<void> }> = [];

const startWorkerFixture = async () => {
  const bundled = await build({
    bundle: true,
    conditions: ['workerd'],
    entryPoints: [join(repoRoot, 'src/worker-global.ts')],
    external: ['cloudflare:*', 'node:*'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(repoRoot, 'tsconfig.json'),
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: 'scheduled-admin@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script: bundled.outputFiles[0].text,
      // Enables the local `/cdn-cgi/local/scheduled` trigger endpoint.
      triggers: [{ schedule: '* * * * *', type: 'scheduled' }],
      unsafeTriggerHandlers: true,
    }),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }

    disposed = true;
    await mf.dispose();
  };

  fixtures.push({ dispose });

  const database = await mf.getD1Database('DB');
  const names = (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }

  return {
    db: database,
    dispatchScheduled: async () => {
      const response = await mf.dispatchFetch(
        'http://localhost/cdn-cgi/local/scheduled',
      );
      return response;
    },
    fetchHealth: async () => mf.dispatchFetch('http://localhost/health'),
  };
};

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => fixture.dispose()),
  );
});

describe('scheduled notification dispatch export', () => {
  test('runs in workerd, records a tick, and keeps HTTP serving', async () => {
    const fx = await startWorkerFixture();
    const scheduled = await fx.dispatchScheduled();
    expect(scheduled.status).toBeLessThan(500);

    const state = await fx.db
      .prepare(
        'SELECT last_tick_at, config_error_code FROM notification_dispatch_state WHERE workspace_id = ?',
      )
      .bind(WORKSPACE)
      .first<{ config_error_code: null | string; last_tick_at: number }>();
    expect(Number(state?.last_tick_at)).toBeGreaterThan(0);

    const health = await fx.fetchHealth();
    expect(health.status).toBe(200);
  });

  test('records a safe configuration error and never sends through a missing binding', async () => {
    const fx = await startWorkerFixture();
    const now = Date.now();
    await fx.db
      .prepare(
        `INSERT INTO email_settings (
          workspace_id, provider, enabled, from_email, from_name,
          canonical_origin, revision, updated_at, write_token
        ) VALUES (?, 'cloudflare', 1, 'notifications@example.test', 'LeadScroll',
          'https://crm.example.test', 1, ?, 'seed')`,
      )
      .bind(WORKSPACE, now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES ('scheduled-user', 'Staff', 'staff@example.test', 0, ?, ?)`,
      )
      .bind(now, now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO notification_preferences (workspace_id, user_id, new_lead_email, updated_at)
          VALUES (?, 'scheduled-user', 1, ?)`,
      )
      .bind(WORKSPACE, now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO leads (id, workspace_id, source, custom_fields, created_at, updated_at)
          VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 'Test', '{}', ?, ?)`,
      )
      .bind(WORKSPACE, now, now)
      .run();
    await fx.db
      .prepare(
        `INSERT INTO notification_outbox (
          id, workspace_id, event_key, lead_id, recipient_user_id,
          recipient_email, template_version, status, next_attempt_at,
          created_at, updated_at
        ) VALUES ('scheduled-out', ?, 'lead.created:01ARZ3NDEKTSV4RRFFQ69G5FAV',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'scheduled-user', 'staff@example.test',
          1, 'pending', ?, ?, ?)`,
      )
      .bind(WORKSPACE, now, now, now)
      .run();

    await fx.dispatchScheduled();

    const state = await fx.db
      .prepare(
        'SELECT config_error_code FROM notification_dispatch_state WHERE workspace_id = ?',
      )
      .bind(WORKSPACE)
      .first<{ config_error_code: null | string }>();
    expect(state?.config_error_code).toBe('cloudflare_binding_missing');

    const row = await fx.db
      .prepare('SELECT status FROM notification_outbox WHERE id = ?')
      .bind('scheduled-out')
      .first<{ status: string }>();
    // The intent is durable and untouched; it is not silently failed.
    expect(row?.status).toBe('pending');
  });
});
