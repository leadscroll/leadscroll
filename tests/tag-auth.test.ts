import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Authorization boundary for the tag catalog routes added by this change.
 * `/v1/tags` and `/v1/tag-scopes` are staff-session routes under the shared
 * auth gate; they must reject anonymous callers, reject a valid browser intake
 * token (which is authorized only for the public intake route), and keep the
 * existing staff origin/content-type checks.
 */

const repoRoot = process.cwd();
const APP_ORIGIN = 'https://tag-auth-test.example';
const WORKSPACE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BROWSER_TOKEN = 'lsc_pub_tag_auth_test_token';

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

  const bundled = await build({
    bundle: true,
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

type Fixture = {
  dispose: () => Promise<void>;
  request: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
};

type RequestInit = {
  body?: string;
  contentType?: null | string;
  headers?: Record<string, string>;
  method?: string;
  origin?: null | string;
};

const startFixture = async (options: {
  authenticated: boolean;
}): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ...(options.authenticated
          ? { DEV_ADMIN_EMAIL: 'tag-auth@example.test' }
          : {}),
        ENVIRONMENT: 'test',
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

  try {
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

    await database
      .prepare(
        `INSERT INTO api_tokens (id, workspace_id, name, prefix, scope, type, token, created_at)
         VALUES (?, ?, 'Browser', 'lsc_pub_tag', 'intake:write', 'browser', ?, ?)`,
      )
      .bind('01ARZ3NDEKTSV4RRFFQ69G5FB0', WORKSPACE, BROWSER_TOKEN, Date.now())
      .run();

    const request = async (
      path: string,
      init: RequestInit = {},
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      const headers: Record<string, string> = { ...init.headers };
      const origin = init.origin === undefined ? APP_ORIGIN : init.origin;
      if (origin !== null) {
        headers['Origin'] = origin;
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

      return { json, status: response.status };
    };

    return { dispose, request };
  } catch (error) {
    await dispose();
    throw error;
  }
};

test('tag routes reject anonymous callers', async () => {
  const fx = await startFixture({ authenticated: false });
  try {
    const list = await fx.request('/v1/tags', { origin: null });
    expect(list.status).toBe(401);

    const create = await fx.request('/v1/tags', {
      body: JSON.stringify({ name: 'vip' }),
      method: 'POST',
      origin: null,
    });
    expect(create.status).toBe(401);

    const scope = await fx.request(
      '/v1/tag-scopes/01ARZ3NDEKTSV4RRFFQ69G5FB1',
      {
        body: JSON.stringify({ prefix: 'other' }),
        method: 'PATCH',
        origin: null,
      },
    );
    expect(scope.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('a browser intake token cannot reach staff tag routes', async () => {
  const fx = await startFixture({ authenticated: false });
  try {
    const authorization = { Authorization: `Bearer ${BROWSER_TOKEN}` };
    const list = await fx.request('/v1/tags', {
      headers: authorization,
      origin: null,
    });
    expect(list.status).toBe(401);

    const create = await fx.request('/v1/tags', {
      body: JSON.stringify({ name: 'vip' }),
      headers: authorization,
      method: 'POST',
      origin: null,
    });
    expect(create.status).toBe(401);

    // The same token is valid on its own public route, so this is an
    // authorization boundary rather than an unknown token.
    const intake = await fx.request(`/v1/public/intakes/${BROWSER_TOKEN}`, {
      body: JSON.stringify({
        email: 'browser@example.test',
        source: 'website',
      }),
      method: 'POST',
      origin: null,
    });
    expect(intake.status, JSON.stringify(intake)).toBe(201);
  } finally {
    await fx.dispose();
  }
});

test('authenticated tag routes keep the staff origin and content-type checks', async () => {
  const fx = await startFixture({ authenticated: true });
  try {
    const list = await fx.request('/v1/tags', { origin: null });
    expect(list.status).toBe(200);

    const created = await fx.request('/v1/tags', {
      body: JSON.stringify({ name: 'prio:high' }),
      method: 'POST',
      origin: null,
    });
    expect(created.status, JSON.stringify(created)).toBe(201);

    const crossOrigin = await fx.request('/v1/tags', {
      body: JSON.stringify({ name: 'vip' }),
      method: 'POST',
      origin: 'https://evil.example',
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.json).toMatchObject({ code: 'forbidden' });

    const formEncoded = await fx.request('/v1/tags', {
      body: 'name=vip',
      contentType: 'application/x-www-form-urlencoded',
      method: 'POST',
      origin: null,
    });
    expect(formEncoded.status).toBe(415);
    expect(formEncoded.json).toMatchObject({
      code: 'unsupported_media_type',
    });
  } finally {
    await fx.dispose();
  }
});
