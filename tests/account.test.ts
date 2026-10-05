import { type Env, revokeOtherAccountSessions } from '@/db/repository';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Self-service account management coverage.
 *
 * The worker runs in Miniflare in PRODUCTION mode (no DEV_ADMIN_EMAIL
 * bypass), so every route resolves a real Better Auth session from the
 * request cookie. Covered:
 *
 * - /v1/account/sessions requires a staff session, lists only the caller's
 *   live sessions, and never returns token material.
 * - Revoking another session kills that session's cookie; the current
 *   session cannot revoke itself; an unknown id is a 404.
 * - revoke-others keeps the current session alive and kills the rest.
 * - The /api/auth boundary validates name and password bodies before
 *   Better Auth runs (422 with the app error envelope, no write).
 * - A name change updates the session user and the staff list.
 * - A password change requires the current password, revokes every other
 *   session (old cookies die), and re-issues a fresh session cookie that
 *   still works; sign-in uses the new password afterwards.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Account tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://account-test.example';
const SETUP_TOKEN = 'test-invite-token'.padEnd(32, '!');

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

  await assertRepoRoot();
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

type Fixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  raw: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
    clientIp?: string,
    rawBody?: string,
  ) => Promise<RawResult>;
};

type RawResult = {
  cookie: string;
  json: Record<string, unknown>;
  status: number;
};

const startFixture = async (
  bindings: Record<string, string> = {},
): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET: SECRET,
        ENVIRONMENT: 'production',
        SETUP_TOKEN,
        ...bindings,
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

    const raw = async (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
      clientIp = '203.0.113.10',
      rawBody?: string,
    ): Promise<RawResult> => {
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        headers: {
          'cf-connecting-ip': clientIp,
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          ...headers,
        },
        method,
        ...(rawBody === undefined
          ? body === undefined
            ? {}
            : { body: JSON.stringify(body) }
          : { body: rawBody }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      const cookie = (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; ');
      return { cookie, json, status: response.status };
    };

    return { db: database, dispose, raw };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const INITIAL_PASSWORD = 'correct-horse-battery';

/**
 * Creates the bootstrap admin plus one second session for the same account
 * (a second sign-in), so "other sessions" are real.
 */
const startSignedInFixture = async (
  initialPassword = INITIAL_PASSWORD,
): Promise<{
  adminCookie: string;
  adminUserId: string;
  fx: Fixture;
  otherCookie: string;
}> => {
  const fx = await startFixture();
  try {
    const signUp = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: initialPassword,
      },
      { 'X-Setup-Token': SETUP_TOKEN },
      // Sign-up performs a server-side sign-in under the same client IP,
      // so keep each sign-in rate-limit bucket at one request.
      '203.0.113.10',
    );
    expect(signUp.status, JSON.stringify(signUp)).toBe(200);
    expect(signUp.cookie).not.toBe('');

    const secondSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: initialPassword,
      },
      {},
      '203.0.113.11',
    );
    expect(secondSignIn.status, JSON.stringify(secondSignIn)).toBe(200);
    expect(secondSignIn.cookie).not.toBe('');
    expect(secondSignIn.cookie).not.toBe(signUp.cookie);

    const row = await fx.db
      .prepare('SELECT id FROM user WHERE email = ?')
      .bind('admin@example.test')
      .first<{ id: string }>();
    expect(row?.id, 'admin user row must exist').toBeTruthy();

    return {
      adminCookie: signUp.cookie,
      adminUserId: row ? row.id : '',
      fx,
      otherCookie: secondSignIn.cookie,
    };
  } catch (error) {
    await fx.dispose();
    throw error;
  }
};

type SessionRow = {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  ipAddress: null | string;
  userAgent: null | string;
};

const listSessions = async (
  fx: Fixture,
  cookie: string,
): Promise<SessionRow[]> => {
  const result = await fx.raw('/v1/account/sessions', 'GET', undefined, {
    Cookie: cookie,
  });
  expect(result.status, JSON.stringify(result)).toBe(200);
  return result.json.data as SessionRow[];
};

test('account session routes require an authenticated staff session', async () => {
  const fx = await startFixture();
  try {
    for (const [path, method] of [
      ['/v1/account/sessions', 'GET'],
      ['/v1/account/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAX', 'DELETE'],
      ['/v1/account/sessions/revoke-others', 'POST'],
    ] as const) {
      const result = await fx.raw(path, method);
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(result.json.code, `${method} ${path}`).toBe('unauthorized');
    }
  } finally {
    await fx.dispose();
  }
});

test('the session list shows only the caller, never token material', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    expect(rows).toHaveLength(2);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain(INITIAL_PASSWORD);

    const sessionTokens = await fx.db
      .prepare('SELECT token FROM session')
      .all<{ token: string }>();
    for (const row of sessionTokens.results) {
      expect(serialized).not.toContain(row.token);
    }

    for (const row of rows) {
      expect(Object.keys(row).toSorted()).toEqual([
        'createdAt',
        'current',
        'expiresAt',
        'id',
        'ipAddress',
        'userAgent',
      ]);
    }

    expect(rows.filter((row) => row.current)).toHaveLength(1);
  } finally {
    await fx.dispose();
  }
});

test('revoking another session kills its cookie; self-revoke is refused', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    const current = rows.find((row) => row.current);
    const other = rows.find((row) => !row.current);
    expect(current).toBeDefined();
    expect(other).toBeDefined();

    // The other session is alive before the revocation.
    const aliveBefore = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(aliveBefore.status).toBe(200);

    const revoked = await fx.raw(
      `/v1/account/sessions/${other?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(revoked.status, JSON.stringify(revoked)).toBe(204);

    // The other session's cookie no longer authorizes anything.
    const deadAfter = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(deadAfter.status).toBe(401);

    // The current session still works.
    const stillAlive = await listSessions(fx, signedIn.adminCookie);
    expect(stillAlive).toHaveLength(1);
    expect(stillAlive[0]?.id).toBe(current?.id);

    // The current session cannot revoke itself.
    const selfRevoke = await fx.raw(
      `/v1/account/sessions/${current?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(selfRevoke.status, JSON.stringify(selfRevoke)).toBe(409);
    expect(selfRevoke.json.code).toBe('conflict');

    // An unknown id is a 404, not a 204.
    const unknown = await fx.raw(
      '/v1/account/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAX',
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe('not_found');
  } finally {
    await fx.dispose();
  }
});

test('revoke-others keeps the current session and kills the rest', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const result = await fx.raw(
      '/v1/account/sessions/revoke-others',
      'POST',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.json.data).toEqual({ revoked: 1 });

    const remaining = await listSessions(fx, signedIn.adminCookie);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.current).toBe(true);

    const deadOther = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(deadOther.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('the name update boundary validates before Better Auth runs', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const header = { Cookie: signedIn.adminCookie };

    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { email: 'new@example.test', name: 'Renamed' },
      { image: 'https://avatar.example/x.png', name: 'Renamed' },
    ]) {
      const rejected = await fx.raw(
        '/api/auth/update-user',
        'POST',
        body,
        header,
      );
      expect(rejected.status, JSON.stringify({ body, rejected })).toBe(422);
      expect(rejected.json.code).toBe('validation_error');
    }

    const updated = await fx.raw(
      '/api/auth/update-user',
      'POST',
      { name: '  Renamed Admin  ' },
      header,
    );
    expect(updated.status, JSON.stringify(updated)).toBe(200);

    const session = await fx.raw('/api/auth/get-session', 'GET', undefined, {
      Cookie: signedIn.adminCookie,
    });
    expect(session.status).toBe(200);
    const user = session.json.user as { name: string };
    expect(user.name).toBe('Renamed Admin');

    const staff = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: signedIn.adminCookie,
    });
    const rows = staff.json.data as Array<{ id: string; name: string }>;
    expect(rows.find((row) => row.id === signedIn.adminUserId)?.name).toBe(
      'Renamed Admin',
    );

    const stored = await fx.db
      .prepare('SELECT name FROM user WHERE id = ?')
      .bind(signedIn.adminUserId)
      .first<{ name: string }>();
    expect(stored?.name).toBe('Renamed Admin');
  } finally {
    await fx.dispose();
  }
});

test('the password boundary validates lengths before Better Auth runs', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const header = { Cookie: signedIn.adminCookie };

    for (const [index, body] of [
      { newPassword: 'long-enough-password' },
      { currentPassword: INITIAL_PASSWORD },
      { currentPassword: '', newPassword: 'long-enough-password' },
      { currentPassword: INITIAL_PASSWORD, newPassword: 'short' },
      {
        currentPassword: INITIAL_PASSWORD,
        newPassword: 'x'.repeat(256),
      },
      { currentPassword: INITIAL_PASSWORD, newPassword: '   ' },
    ].entries()) {
      const rejected = await fx.raw(
        '/api/auth/change-password',
        'POST',
        body,
        header,
        // Rejected before Better Auth, so its 3-per-10s limiter never
        // fires — but spread IPs anyway so a boundary regression fails on
        // the 422 assertion, not on a confusing 429.
        `198.51.100.${20 + index}`,
      );
      expect(rejected.status, JSON.stringify({ body, rejected })).toBe(422);
      expect(rejected.json.code).toBe('validation_error');
    }

    // No validation rejection wrote anything: the password still works.
    const unchanged = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: INITIAL_PASSWORD,
      },
      {},
      '198.51.100.30',
    );
    expect(unchanged.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('a wrong current password is rejected without revoking sessions', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const result = await fx.raw(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword: 'wrong-horse-battery',
        newPassword: 'new-password-123',
      },
      { Cookie: signedIn.adminCookie },
    );
    expect(result.status, JSON.stringify(result)).toBe(400);

    // Better Auth rejected the change: no session was revoked.
    const rows = await listSessions(fx, signedIn.adminCookie);
    expect(rows).toHaveLength(2);
    const otherStillAlive = await fx.raw(
      '/v1/account/sessions',
      'GET',
      undefined,
      { Cookie: signedIn.otherCookie },
    );
    expect(otherStillAlive.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('changing the password revokes other sessions and re-issues the caller', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const changed = await fx.raw(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword: INITIAL_PASSWORD,
        newPassword: 'new-password-123',
        revokeOtherSessions: false,
      },
      { Cookie: signedIn.adminCookie },
    );
    expect(changed.status, JSON.stringify(changed)).toBe(200);
    // The response re-issues the session cookie for the caller.
    expect(changed.cookie).not.toBe('');

    // The other device's cookie is dead.
    const otherDead = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(otherDead.status).toBe(401);

    // The caller's old cookie was replaced by the re-issued one.
    const oldCookieDead = await fx.raw(
      '/v1/account/sessions',
      'GET',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(oldCookieDead.status).toBe(401);

    // The new cookie works and is the only remaining session.
    const fresh = await listSessions(fx, changed.cookie);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.current).toBe(true);

    // The old password no longer signs in; the new one does. Both use a
    // dedicated client IP: the sign-in limiter allows 3 per 10s and the
    // fixture already spent one on this IP's bucket during sign-up.
    const oldSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: INITIAL_PASSWORD,
      },
      {},
      '198.51.100.40',
    );
    expect(oldSignIn.status).toBe(401);
    const newSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: 'new-password-123',
      },
      {},
      '198.51.100.41',
    );
    expect(newSignIn.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('account routes reject untrusted origins for writes', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    const other = rows.find((row) => !row.current);

    const hostile = await fx.raw(
      `/v1/account/sessions/${other?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie, Origin: 'https://evil.example' },
    );
    expect(hostile.status, JSON.stringify(hostile)).toBe(403);
    expect(hostile.json.code).toBe('forbidden');

    const rowsAfter = await listSessions(fx, signedIn.adminCookie);
    expect(rowsAfter).toHaveLength(2);
  } finally {
    await fx.dispose();
  }
});

const addForeignAccount = async (fx: Fixture, cookie: string) => {
  const invite = await fx.raw(
    '/v1/invites',
    'POST',
    { name: 'Another account' },
    { Cookie: cookie },
  );
  expect(invite.status).toBe(201);
  const token = (invite.json.data as { token: string }).token;
  const signedUp = await fx.raw(
    '/api/auth/sign-up/email',
    'POST',
    {
      email: 'member@example.test',
      name: 'Member',
      password: INITIAL_PASSWORD,
    },
    { 'X-Setup-Token': token },
    '192.0.2.110',
  );
  expect(signedUp.status).toBe(200);
  return {
    cookie: signedUp.cookie,
    sessions: await listSessions(fx, signedUp.cookie),
  };
};

const addExpiredSession = async (fx: Fixture, userId: string) => {
  await fx.db
    .prepare(
      'INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      'expired-session',
      Date.now() - 1_000,
      'expired-test-session-secret',
      Date.now() - 10_000,
      Date.now() - 10_000,
      userId,
    )
    .run();
};

test('sessions isolate users and expired rows, and bulk revocation counts only active devices', async () => {
  const { adminCookie, adminUserId, fx, otherCookie } =
    await startSignedInFixture();
  try {
    const foreign = await addForeignAccount(fx, adminCookie);
    await addExpiredSession(fx, adminUserId);
    const rows = await listSessions(fx, adminCookie);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).not.toContain(foreign.sessions[0].id);
    expect(rows.map((row) => row.id)).not.toContain('expired-session');
    const denied = await fx.raw(
      `/v1/account/sessions/${foreign.sessions[0].id}`,
      'DELETE',
      undefined,
      { Cookie: adminCookie },
    );
    expect(denied.status).toBe(404);
    const bulk = await fx.raw(
      '/v1/account/sessions/revoke-others',
      'POST',
      undefined,
      { Cookie: adminCookie },
    );
    expect(bulk.json.data).toEqual({ revoked: 1 });
    expect(await listSessions(fx, foreign.cookie)).toEqual(foreign.sessions);
    expect(await listSessions(fx, adminCookie)).toHaveLength(1);
    expect(
      (
        await fx.raw('/v1/account/sessions', 'GET', undefined, {
          Cookie: otherCookie,
        })
      ).status,
    ).toBe(401);
    const expired = await fx.db
      .prepare('SELECT id FROM session WHERE id = ?')
      .bind('expired-session')
      .first();
    expect(expired).toBeNull();
  } finally {
    await fx.dispose();
  }
});

const authMutations = [
  ['/api/auth/update-user', { name: 'Updated' }],
  [
    '/api/auth/change-password',
    { currentPassword: INITIAL_PASSWORD, newPassword: 'new-password-123' },
  ],
] as const;

test('valid anonymous account mutations require a session; malformed bodies fail validation without echoing secrets', async () => {
  const fx = await startFixture();
  try {
    for (const [path, body] of authMutations) {
      expect((await fx.raw(path, 'POST', body)).status).toBe(401);
      for (const invalid of [null, [], 'secret-password-value', 12]) {
        const result = await fx.raw(path, 'POST', invalid);
        expect(result.status).toBe(422);
        expect(JSON.stringify(result.json)).not.toContain(
          'secret-password-value',
        );
      }

      const broken = await fx.raw(
        path,
        'POST',
        undefined,
        {},
        '192.0.2.120',
        '{invalid JSON',
      );
      expect(broken.status).toBe(422);
    }
  } finally {
    await fx.dispose();
  }
});

test('disabled staff with a stale real session cannot list, revoke or mutate their account', async () => {
  const { adminCookie, adminUserId, fx } = await startSignedInFixture();
  try {
    const rows = await listSessions(fx, adminCookie);
    // Deliberately preserve sessions to prove the enabled-account check itself.
    await fx.db
      .prepare('UPDATE user SET disabled_at = ? WHERE id = ?')
      .bind(Date.now(), adminUserId)
      .run();
    for (const [path, method, body] of [
      ['/v1/account/sessions', 'GET', undefined],
      [
        `/v1/account/sessions/${rows.find((row) => !row.current)?.id}`,
        'DELETE',
        undefined,
      ],
      ['/v1/account/sessions/revoke-others', 'POST', undefined],
      ...authMutations.map(
        ([authPath, authBody]) => [authPath, 'POST', authBody] as const,
      ),
    ] as const) {
      expect(
        (await fx.raw(path, method, body, { Cookie: adminCookie })).status,
        path,
      ).toBe(401);
    }

    const unchanged = await fx.db
      .prepare('SELECT name FROM user WHERE id = ?')
      .bind(adminUserId)
      .first<{ name: string }>();
    expect(unchanged?.name).toBe('Test Admin');
  } finally {
    await fx.dispose();
  }
});

test('every account write rejects hostile origins without changing sessions or credentials', async () => {
  const { adminCookie, fx } = await startSignedInFixture();
  try {
    const rows = await listSessions(fx, adminCookie);
    for (const [path, method, body] of [
      [
        `/v1/account/sessions/${rows.find((row) => !row.current)?.id}`,
        'DELETE',
        undefined,
      ],
      ['/v1/account/sessions/revoke-others', 'POST', undefined],
      ...authMutations.map(
        ([authPath, authBody]) => [authPath, 'POST', authBody] as const,
      ),
    ] as const) {
      expect(
        (
          await fx.raw(path, method, body, {
            Cookie: adminCookie,
            Origin: 'https://hostile.example',
          })
        ).status,
        path,
      ).toBe(403);
    }

    expect(await listSessions(fx, adminCookie)).toEqual(rows);
  } finally {
    await fx.dispose();
  }
});

test('account routes fail closed when authentication is not configured', async () => {
  const fx = await startFixture({ BETTER_AUTH_SECRET: '' });
  try {
    for (const [path, method, body] of [
      ['/v1/account/sessions', 'GET', undefined],
      ['/v1/account/sessions/opaque-id', 'DELETE', undefined],
      ['/v1/account/sessions/revoke-others', 'POST', undefined],
      ...authMutations.map(
        ([authPath, authBody]) => [authPath, 'POST', authBody] as const,
      ),
    ] as const) {
      const result = await fx.raw(path, method, body);
      expect(result.status, path).toBe(503);
      expect(result.json.code).toBe('authentication_not_configured');
    }
  } finally {
    await fx.dispose();
  }
});

test('new-password boundaries accept 8, 128, 129 and 255 characters and verify existing long credentials', async () => {
  const initialPassword = 'p'.repeat(255);
  const { adminCookie, fx } = await startSignedInFixture(initialPassword);
  let cookie = adminCookie;
  let currentPassword = initialPassword;
  try {
    for (const [index, length] of [128, 129, 255, 8].entries()) {
      const newPassword = 'x'.repeat(length);
      const result = await fx.raw(
        '/api/auth/change-password',
        'POST',
        { currentPassword, newPassword },
        { Cookie: cookie },
        `192.0.2.${130 + index}`,
      );
      expect(result.status, `length ${length}`).toBe(200);
      cookie = result.cookie;
      currentPassword = newPassword;
      expect(await listSessions(fx, cookie)).toHaveLength(1);
    }

    for (const [index, newPassword] of [
      'x'.repeat(7),
      'x'.repeat(256),
      ' '.repeat(8),
    ].entries()) {
      const rejected = await fx.raw(
        '/api/auth/change-password',
        'POST',
        { currentPassword, newPassword },
        { Cookie: cookie },
        `192.0.2.${140 + index}`,
      );
      expect(rejected.status).toBe(422);
      expect(JSON.stringify(rejected.json)).not.toContain(currentPassword);
    }
  } finally {
    await fx.dispose();
  }
});

test('profile accepts exact trimmed boundaries and rejects unexpected fields on trailing slash variants', async () => {
  const { adminCookie, fx } = await startSignedInFixture();
  try {
    for (const name of ['  x  ', ` ${'x'.repeat(200)} `]) {
      expect(
        (
          await fx.raw(
            '/api/auth/update-user/',
            'POST',
            { name },
            { Cookie: adminCookie },
          )
        ).status,
      ).toBe(200);
    }

    for (const path of ['/api/auth/update-user', '/api/auth/update-user/']) {
      const result = await fx.raw(
        path,
        'POST',
        { image: 'https://example.test/image', name: 'Wrong' },
        { Cookie: adminCookie },
      );
      expect(result.status).toBe(422);
    }

    const alias = await fx.raw(
      '/api/auth/%75pdate-user',
      'POST',
      { image: 'https://example.test/image', name: 'Wrong' },
      { Cookie: adminCookie },
    );
    expect(alias.status).toBe(404);
  } finally {
    await fx.dispose();
  }
});

test('wrong-password attempts use the upstream change-password rate limiter', async () => {
  const { adminCookie, fx } = await startSignedInFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await fx.raw(
        '/api/auth/change-password',
        'POST',
        {
          currentPassword: 'wrong-current-password',
          newPassword: 'new-password-123',
        },
        { Cookie: adminCookie },
        '192.0.2.150',
      );
      expect(result.status).toBe(400);
    }

    const blocked = await fx.raw(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword: 'wrong-current-password',
        newPassword: 'new-password-123',
      },
      { Cookie: adminCookie },
      '192.0.2.150',
    );
    expect(blocked.status).toBe(429);
    expect(await listSessions(fx, adminCookie)).toHaveLength(2);
  } finally {
    await fx.dispose();
  }
});

test('development bypass has no real session and cannot use account-session endpoints', async () => {
  const fx = await startFixture({
    DEV_ADMIN_EMAIL: 'developer@example.test',
    ENVIRONMENT: 'development',
  });
  try {
    expect((await fx.raw('/v1/staff')).status).toBe(200);
    for (const [path, method] of [
      ['/v1/account/sessions', 'GET'],
      ['/v1/account/sessions/opaque-id', 'DELETE'],
      ['/v1/account/sessions/revoke-others', 'POST'],
    ] as const) {
      expect((await fx.raw(path, method)).status).toBe(401);
    }
  } finally {
    await fx.dispose();
  }
});

test('a delayed bulk revocation using a pre-rotation identity preserves the replacement session', async () => {
  const { adminCookie, adminUserId, fx } = await startSignedInFixture();
  try {
    const before = await listSessions(fx, adminCookie);
    const authenticatedSessionId = before.find((row) => row.current)?.id;
    expect(authenticatedSessionId).toBeDefined();
    const changed = await fx.raw(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword: INITIAL_PASSWORD,
        newPassword: 'rotated-race-password',
      },
      { Cookie: adminCookie },
    );
    expect(changed.status).toBe(200);
    const replacement = await listSessions(fx, changed.cookie);
    expect(replacement).toHaveLength(1);
    expect(replacement[0].id).not.toBe(authenticatedSessionId);

    // Reproduce the delayed persistence step with the identity authenticated
    // before rotation; reauthenticating the old cookie would hide this race.
    // This repository operation only consults the database binding.
    const revoked = await revokeOtherAccountSessions(
      { DB: fx.db } as Env,
      adminUserId,
      authenticatedSessionId ?? '',
    );
    expect(revoked).toBe(0);
    expect(await listSessions(fx, changed.cookie)).toEqual(replacement);
  } finally {
    await fx.dispose();
  }
});

test('bulk revocation refuses expired or foreign caller authority in the DELETE itself', async () => {
  const { adminCookie, adminUserId, fx, otherCookie } =
    await startSignedInFixture();
  try {
    const foreign = await addForeignAccount(fx, adminCookie);
    const rows = await listSessions(fx, adminCookie);
    const otherId = rows.find((row) => !row.current)?.id;
    expect(otherId).toBeDefined();
    const repositoryEnvironment = { DB: fx.db } as Env;
    expect(
      await revokeOtherAccountSessions(
        repositoryEnvironment,
        adminUserId,
        foreign.sessions[0].id,
      ),
    ).toBe(0);
    expect(await listSessions(fx, adminCookie)).toEqual(rows);

    await fx.db
      .prepare('UPDATE session SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, otherId)
      .run();
    expect(
      await revokeOtherAccountSessions(
        repositoryEnvironment,
        adminUserId,
        otherId ?? '',
      ),
    ).toBe(0);
    expect(await listSessions(fx, adminCookie)).toHaveLength(1);
    expect(
      (
        await fx.raw('/v1/account/sessions', 'GET', undefined, {
          Cookie: otherCookie,
        })
      ).status,
    ).toBe(401);
    expect(await listSessions(fx, foreign.cookie)).toEqual(foreign.sessions);
  } finally {
    await fx.dispose();
  }
});
