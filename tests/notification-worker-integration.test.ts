import { TEST_ENCRYPTION_KEY } from './notification-fixture';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * Real-workerd integration for best-effort notification delivery.
 *
 * The real worker entry is bundled and run in Miniflare with the real D1
 * baseline. Outbound email is intercepted by a gated mock provider, so the
 * test can prove two things the unit suites cannot:
 *
 * 1. the HTTP lead-creation response is returned while the provider call is
 *    still unresolved (subscriber work is on `ctx.waitUntil`, not the request
 *    critical path), and
 * 2. the background send completes afterwards through the real Worker
 *    execution context.
 */

const repoRoot = process.cwd();
const APP_ORIGIN = 'https://integration-test.example';
const ADMIN_EMAIL = 'integration-admin@example.test';
const STAFF_EMAIL = 'integration-staff@example.test';

let workerScriptPromise: null | Promise<string> = null;
const bundleWorker = async (): Promise<string> => {
  workerScriptPromise ??= (async () => {
    const bundled = await build({
      bundle: true,
      conditions: ['workerd'],
      define: { 'process.env.NODE_ENV': '"production"' },
      entryPoints: [join(repoRoot, 'src/worker-global.ts')],
      external: ['cloudflare:*', 'node:*'],
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(repoRoot, 'tsconfig.json'),
      write: false,
    });
    return bundled.outputFiles[0].text;
  })();
  return workerScriptPromise;
};

type IntegrationFixture = {
  dispose: () => Promise<void>;
  providerCalls: ProviderCall[];
  providerCompleted: number[];
  releaseProvider: (index: number) => void;
  request: (
    path: string,
    init: { body: string; method: string },
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  waitFor: (
    predicate: () => boolean,
    description: string,
    timeoutMs?: number,
  ) => Promise<void>;
};

type ProviderCall = {
  body: string;
  headers: Record<string, string>;
  url: string;
};

const fixtures: IntegrationFixture[] = [];

const startIntegrationFixture = async (): Promise<IntegrationFixture> => {
  const script = await bundleWorker();
  const providerCalls: ProviderCall[] = [];
  const providerCompleted: number[] = [];
  const gates: Array<() => void> = [];

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: ADMIN_EMAIL,
        EMAIL_SETTINGS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
        ENVIRONMENT: 'test',
        SETUP_TOKEN: 'test-setup-token'.padEnd(32, '!'),
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      // Miniflare supports a function outbound service; the V4 types only
      // describe service designators, so the cast keeps the runtime behavior.
      outboundService: (async (request: Request) => {
        const body = await request.text();
        providerCalls.push({
          body,
          headers: Object.fromEntries(request.headers.entries()),
          url: request.url,
        });
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        providerCompleted.push(providerCalls.length);
        return Response.json({ id: `re-mock-${providerCalls.length}` });
      }) as never,
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

  try {
    const database = await mf.getD1Database('DB');
    for (const name of (await readdir(join(repoRoot, 'drizzle')))
      .filter((entry) => entry.endsWith('.sql'))
      .toSorted()) {
      const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
      await database.batch(
        sql
          .split('--> statement-breakpoint')
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((statement) => database.prepare(statement)),
      );
    }

    const now = Date.now();
    await database
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .bind('integration-admin', 'Integration Admin', ADMIN_EMAIL, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .bind('integration-staff', 'Integration Staff', STAFF_EMAIL, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO notification_preferences (user_id, new_lead_email, updated_at)
          VALUES ('integration-staff', 1, ?)`,
      )
      .bind(now)
      .run();

    const { encryptCredential } =
      await import('@/notifications/credential-crypto');
    const envelope = await encryptCredential(TEST_ENCRYPTION_KEY, {
      provider: 'resend',
      value: 're_integration_key',
    });
    const { DEFAULT_INSTALLATION_CONFIG } = await import('@/domain/schemas');
    const document = {
      ...DEFAULT_INSTALLATION_CONFIG,
      email: {
        canonicalOrigin: APP_ORIGIN,
        credential: envelope,
        enabled: true,
        fromEmail: 'notifications@example.test',
        fromName: 'LeadScroll',
        provider: 'resend',
      },
      revision: 1,
    };
    await database
      .prepare(
        `INSERT INTO installation_config (
          id, document_json, write_version, write_token
        ) VALUES ('installation', ?, 1, 'integration-token')`,
      )
      .bind(JSON.stringify(document))
      .run();

    const fixture: IntegrationFixture = {
      dispose,
      providerCalls,
      providerCompleted,
      releaseProvider: (index) => {
        gates[index]();
      },
      request: async (path, init) => {
        const response = await mf.dispatchFetch(`${APP_ORIGIN}${path}`, {
          body: init.body,
          headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
          method: init.method,
        });
        const text = await response.text();
        return {
          json: JSON.parse(text) as Record<string, unknown>,
          status: response.status,
        };
      },
      waitFor: async (predicate, description, timeoutMs = 5_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
          }

          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
      },
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await dispose();
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fx) => fx.dispose()));
});

describe('best-effort notification integration', () => {
  test('HTTP creation returns before the provider resolves and waitUntil sends afterwards', async () => {
    const fx = await startIntegrationFixture();

    const responsePromise = fx.request('/v1/leads', {
      body: JSON.stringify({ email: 'integration-lead@example.test' }),
      method: 'POST',
    });

    // The response must not wait for the gated provider call.
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              'The HTTP response waited for the background provider call.',
            ),
          );
        }, 3_000);
      }),
    ]);
    expect(response.status).toBe(201);

    // waitUntil work is already running: the provider was contacted and is
    // blocked on the gate we still hold.
    await fx.waitFor(
      () => fx.providerCalls.length === 1,
      'the mocked provider call to start',
    );
    expect(fx.providerCalls).toHaveLength(1);

    fx.releaseProvider(0);
    await fx.waitFor(
      () => fx.providerCompleted.length === 1,
      'the mocked provider call to finish',
    );

    const [call] = fx.providerCalls;
    expect(call.url).toBe('https://api.resend.com/emails');
    const payload = JSON.parse(call.body) as {
      from: string;
      subject: string;
      to: string[];
    };
    expect(payload.to).toEqual([STAFF_EMAIL]);
    expect(payload.subject).toBe('A new lead is available in LeadScroll');
    expect(payload.from).toBe('LeadScroll <notifications@example.test>');
    expect(call.headers['idempotency-key']).toMatch(
      /^leadscroll-notification:/u,
    );
    // The mocked key must never reach the wire.
    expect(call.body).not.toContain('re_integration_key');
  });
});
