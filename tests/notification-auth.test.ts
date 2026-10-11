import { TEST_ENCRYPTION_KEY } from './notification-fixture';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * HTTP-boundary tests for the notification and email-settings APIs. The real
 * worker runs in Miniflare with a real D1 database and the development
 * identity bypass (never production), so guards, DTO redaction, CAS revisions,
 * and origin checks are exercised against the deployed request path.
 */

const repoRoot = process.cwd();
const APP_ORIGIN = 'https://notify-test.example';
const ADMIN_EMAIL = 'notify-admin@example.test';
const ADMIN_ID = 'notify-admin-id';
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const workerScripts = new Map<string, string>();
const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached !== undefined) {
    return cached;
  }

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
  const script = bundled.outputFiles[0].text;
  workerScripts.set('default', script);
  return script;
};

type ApiFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  request: (
    path: string,
    init?: {
      body?: string;
      contentType?: null | string;
      method?: string;
      origin?: null | string;
    },
  ) => Promise<{
    headers: { get: (name: string) => null | string };
    json: Record<string, unknown>;
    status: number;
  }>;
};

const fixtures: ApiFixture[] = [];

const startApiFixture = async (
  options: { identity?: boolean; permission?: boolean } = {},
): Promise<ApiFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ...(options.identity === false ? {} : { DEV_ADMIN_EMAIL: ADMIN_EMAIL }),
        EMAIL_SETTINGS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ENVIRONMENT: 'test',
        SETUP_TOKEN: 'test-setup-token'.padEnd(32, '!'),
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script,
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

  const fixture: ApiFixture = {
    db: await mf.getD1Database('DB'),
    dispose,
    request: async (path, init = {}) => {
      const headers: Record<string, string> = {};
      const origin = init.origin === undefined ? APP_ORIGIN : init.origin;
      if (origin !== null) {
        headers.Origin = origin;
      }

      const contentType =
        init.contentType === undefined ? 'application/json' : init.contentType;
      if (contentType !== null && init.body !== undefined) {
        headers['Content-Type'] = contentType;
      }

      const response = await mf.dispatchFetch(`${APP_ORIGIN}${path}`, {
        ...(init.body === undefined ? {} : { body: init.body }),
        headers,
        method: init.method ?? 'GET',
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      return { headers: response.headers, json, status: response.status };
    },
  };
  fixtures.push(fixture);

  // Apply the real migration history, then seed the bypass account.
  const names = (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .filter(Boolean)) {
      await fixture.db.prepare(statement).run();
    }
  }

  if (options.identity !== false) {
    const now = Date.now();
    await fixture.db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .bind(ADMIN_ID, 'Notify Admin', ADMIN_EMAIL, now, now)
      .run();
    if (options.permission !== false) {
      await fixture.db
        .prepare(
          `INSERT INTO email_settings_permissions (workspace_id, user_id, granted_at, granted_by_user_id)
            VALUES (?, ?, ?, NULL)`,
        )
        .bind(WORKSPACE, ADMIN_ID, now)
        .run();
    }
  }

  return fixture;
};

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => fixture.dispose()),
  );
});

const saveBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    credential: { operation: 'keep' },
    enabled: false,
    expectedRevision: 0,
    fromEmail: null,
    fromName: null,
    provider: 'disabled',
    ...overrides,
  });

describe('email settings API guards', () => {
  test('anonymous callers and intake tokens cannot reach installation settings', async () => {
    const fx = await startApiFixture({ identity: false });
    const settings = await fx.request('/v1/settings/email');
    expect(settings.status).toBe(401);

    const preferences = await fx.request('/v1/account/notifications');
    expect(preferences.status).toBe(401);

    const bearer = await fx.request('/v1/settings/email', {
      origin: null,
    });
    expect(bearer.status).toBe(401);
  });

  test('authenticated staff without the capability are denied with an explicit owner state', async () => {
    const fx = await startApiFixture({ permission: false });
    const noOwner = await fx.request('/v1/settings/email');
    expect(noOwner.status).toBe(403);
    expect(noOwner.json).toMatchObject({
      code: 'email_settings_owner_required',
    });

    await fx.db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES ('other-id', 'Other', 'other@example.test', 0, ?, ?)`,
      )
      .bind(Date.now(), Date.now())
      .run();
    await fx.db
      .prepare(
        `INSERT INTO email_settings_permissions (workspace_id, user_id, granted_at, granted_by_user_id)
          VALUES (?, 'other-id', ?, NULL)`,
      )
      .bind(WORKSPACE, Date.now())
      .run();
    const denied = await fx.request('/v1/settings/email');
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'forbidden' });
  });

  test('a disabled bypass account is rejected like a disabled session', async () => {
    const fx = await startApiFixture();
    await fx.db
      .prepare('UPDATE user SET disabled_at = ? WHERE id = ?')
      .bind(Date.now(), ADMIN_ID)
      .run();
    expect((await fx.request('/v1/settings/email')).status).toBe(401);
  });

  test('cross-origin and non-JSON writes are rejected before any storage', async () => {
    const fx = await startApiFixture();
    const crossOrigin = await fx.request('/v1/settings/email', {
      body: saveBody(),
      method: 'PUT',
      origin: 'https://evil.example',
    });
    expect(crossOrigin.status).toBe(403);

    const form = await fx.request('/v1/settings/email', {
      body: 'provider=resend',
      contentType: 'application/x-www-form-urlencoded',
      method: 'PUT',
    });
    expect(form.status).toBe(415);
    expect(
      await fx.db
        .prepare('SELECT COUNT(*) AS total FROM email_settings')
        .first(),
    ).toMatchObject({ total: 0 });
  });
});

describe('email settings API behavior', () => {
  test('saves and reloads a disabled configuration without sending', async () => {
    const fx = await startApiFixture();
    const saved = await fx.request('/v1/settings/email', {
      body: saveBody(),
      method: 'PUT',
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(saved.json.data).toMatchObject({
      enabled: false,
      provider: 'disabled',
      revision: 1,
      test: null,
    });

    expect(
      await fx.db
        .prepare('SELECT COUNT(*) AS total FROM notification_test_attempts')
        .first(),
    ).toMatchObject({ total: 0 });
  });

  test('stores a write-only Resend key, reports hasApiKey, and never leaks it', async () => {
    const fx = await startApiFixture();
    await fx.request('/v1/settings/email', {
      body: saveBody({
        enabled: true,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });
    const replaced = await fx.request('/v1/settings/email', {
      body: saveBody({
        credential: { operation: 'replace', value: 're_super_secret' },
        enabled: true,
        expectedRevision: 1,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.data).toMatchObject({
      hasApiKey: true,
      readiness: { availability: 'configured', reasonCode: null },
      revision: 2,
    });
    expect(JSON.stringify(replaced.json)).not.toContain('re_super_secret');

    const fetched = await fx.request('/v1/settings/email');
    expect(JSON.stringify(fetched.json)).not.toContain('re_super_secret');
    expect(JSON.stringify(fetched.json)).not.toContain('ciphertext');

    const stored = await fx.db
      .prepare('SELECT ciphertext FROM email_credentials WHERE provider = ?')
      .bind('resend')
      .first<{ ciphertext: string }>();
    expect(stored?.ciphertext).not.toContain('re_super_secret');
    expect(stored?.ciphertext.length).toBeGreaterThan(20);
  });

  test('removing the key disables Resend and stale revisions conflict', async () => {
    const fx = await startApiFixture();
    await fx.request('/v1/settings/email', {
      body: saveBody({
        enabled: true,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });
    await fx.request('/v1/settings/email', {
      body: saveBody({
        credential: { operation: 'replace', value: 're_remove_me' },
        enabled: true,
        expectedRevision: 1,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });
    const removed = await fx.request('/v1/settings/email', {
      body: saveBody({
        credential: { operation: 'remove' },
        enabled: true,
        expectedRevision: 2,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });
    expect(removed.status).toBe(200);
    expect(removed.json.data).toMatchObject({
      enabled: false,
      hasApiKey: false,
      provider: 'disabled',
    });

    const stale = await fx.request('/v1/settings/email', {
      body: saveBody({ expectedRevision: 2 }),
      method: 'PUT',
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'revision_conflict' });
  });

  test('cloudflare without the binding reports the missing local resource', async () => {
    const fx = await startApiFixture();
    const selected = await fx.request('/v1/settings/email', {
      body: saveBody({
        enabled: true,
        fromEmail: 'notifications@example.test',
        provider: 'cloudflare',
      }),
      method: 'PUT',
    });
    // The provider is selectable; readiness reports the missing binding so the
    // owner can add it or switch to Resend without losing intent.
    expect(selected.status).toBe(200);
    expect(selected.json.data).toMatchObject({
      provider: 'cloudflare',
      readiness: {
        availability: 'misconfigured',
        reasonCode: 'cloudflare_binding_missing',
      },
    });
  });

  test('the test action rejects stale revisions and misconfiguration before sending', async () => {
    const fx = await startApiFixture();
    await fx.request('/v1/settings/email', {
      body: saveBody({
        enabled: true,
        fromEmail: 'notifications@example.test',
        provider: 'resend',
      }),
      method: 'PUT',
    });

    const stale = await fx.request('/v1/settings/email/test', {
      body: JSON.stringify({
        expectedRevision: 99,
        requestId: 'req-stale',
      }),
      method: 'POST',
    });
    expect(stale.status).toBe(409);

    const misconfigured = await fx.request('/v1/settings/email/test', {
      body: JSON.stringify({
        expectedRevision: 1,
        requestId: 'req-misconfigured',
      }),
      method: 'POST',
    });
    expect(misconfigured.status).toBe(422);
    expect(misconfigured.json).toMatchObject({ code: 'email_misconfigured' });

    expect(
      await fx.db
        .prepare('SELECT COUNT(*) AS total FROM notification_test_attempts')
        .first(),
    ).toMatchObject({ total: 0 });
  });

  test('forged permission or provider override fields are ignored by the schema', async () => {
    const fx = await startApiFixture();
    const response = await fx.request('/v1/settings/email', {
      body: saveBody({
        manageEmailSettings: true,
        providerBaseUrl: 'https://evil.example',
      }),
      method: 'PUT',
    });
    expect(response.status).toBe(200);
    const reloaded = await fx.request('/v1/settings/email');
    expect(JSON.stringify(reloaded.json)).not.toContain('evil.example');
  });
});

describe('self-service notification API', () => {
  test('reads and updates the caller preference and own history', async () => {
    const fx = await startApiFixture();
    const initial = await fx.request('/v1/account/notifications');
    expect(initial.status).toBe(200);
    expect(initial.json.data).toMatchObject({
      availability: 'disabled',
      newLeadEmail: false,
      provider: null,
    });

    const saved = await fx.request('/v1/account/notifications', {
      body: JSON.stringify({ newLeadEmail: true }),
      method: 'PUT',
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data).toMatchObject({ newLeadEmail: true });

    const reloaded = await fx.request('/v1/account/notifications');
    expect(reloaded.json.data).toMatchObject({ newLeadEmail: true });

    const history = await fx.request('/v1/account/notifications/history');
    expect(history.status).toBe(200);
    expect(history.json).toMatchObject({ data: [], nextCursor: null });
  });

  test('rejects a non-boolean preference and unknown history fields', async () => {
    const fx = await startApiFixture();
    const invalid = await fx.request('/v1/account/notifications', {
      body: JSON.stringify({ newLeadEmail: 'yes' }),
      method: 'PUT',
    });
    expect(invalid.status).toBe(422);

    const page = await fx.request(
      '/v1/account/notifications/history?limit=999',
    );
    expect(page.status).toBe(422);
  });
});
