import { DEFAULT_WORKSPACE_ID } from '@/db/repository';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed regression tests for persisted tags, scopes and assignments:
 * inferred-scope CRUD, database-level exclusivity, catalog integrity under
 * rename/delete, server-side filters, bulk mutation, intake tag creation and
 * the legacy `source` backfill migration.
 */

const repoRoot = process.cwd();
const WORKSPACE = DEFAULT_WORKSPACE_ID;

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

type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ json: Record<string, unknown>; status: number }>;

type Fixture = {
  api: Api;
  db: D1Database;
  dispose: () => Promise<void>;
  migrationNames: string[];
};

const applyMigrations = async (
  database: D1Database,
  names: readonly string[],
): Promise<void> => {
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
};

const startFixture = async (): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: 'tags-regression@example.test',
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
    const migrationNames = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    await applyMigrations(database, migrationNames);

    const api: Api = async (
      path,
      method = 'GET',
      body?: unknown,
      headers = {},
    ) => {
      const response = await mf.dispatchFetch(
        `https://tags-test.example${path}`,
        {
          headers: { 'Content-Type': 'application/json', ...headers },
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      return { json, status: response.status };
    };

    return { api, db: database, dispose, migrationNames };
  } catch (error) {
    await dispose();
    throw error;
  }
};

type TagJson = {
  color: string;
  id: string;
  label: string;
  leadCount: number;
  name: string;
  scopeId: null | string;
};

const createTag = async (api: Api, name: string): Promise<TagJson> => {
  const response = await api('/v1/tags', 'POST', { name });
  expect(response.status, JSON.stringify(response)).toBe(201);
  return response.json.data as TagJson;
};

const createLead = async (api: Api, body: Record<string, unknown>) => {
  const response = await api('/v1/leads', 'POST', body);
  expect(response.status, JSON.stringify(response)).toBe(201);
  return response.json.data as { id: string; tags: TagJson[] };
};

const getLead = async (api: Api, id: string) => {
  const response = await api(`/v1/leads/${id}`);
  expect(response.status, JSON.stringify(response)).toBe(200);
  return response.json.data as { id: string; tags: TagJson[] };
};

const insertLegacyLead = async (
  database: D1Database,
  lead: { id: string; source: string },
): Promise<void> => {
  await database
    .prepare(
      `INSERT INTO leads (
        id, workspace_id, email, first_name, last_name,
        source, estimated_value, custom_fields,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, NULL, 'Legacy', 'Lead', ?, NULL, '{}', ?, ?, NULL)`,
    )
    .bind(lead.id, WORKSPACE, lead.source, Date.now(), Date.now())
    .run();
};

test('catalog infers scopes and enforces exclusive assignment', async () => {
  const fx = await startFixture();
  try {
    const considering = await createTag(fx.api, 'fall26:considering');
    const closed = await createTag(fx.api, 'fall26:closed');
    expect(considering.scopeId).not.toBeNull();
    expect(closed.scopeId).toBe(considering.scopeId);
    expect(considering.color).toBe(closed.color);

    const duplicate = await fx.api('/v1/tags', 'POST', {
      name: 'FALL26:CLOSED',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.code).toBe('tag_exists');

    const catalog = await fx.api('/v1/tags');
    expect(catalog.status).toBe(200);
    const catalogData = catalog.json.data as {
      scopes: Array<{ id: string; prefix: string }>;
      tags: TagJson[];
    };
    expect(catalogData.scopes).toHaveLength(1);
    expect(catalogData.tags).toHaveLength(2);

    const lead = await createLead(fx.api, {
      email: 'exclusive@example.test',
      firstName: 'Exclusive',
      source: 'website',
    });
    // Two same-scope ids in one replacement: last in the list wins.
    const saved = await fx.api(`/v1/leads/${lead.id}/tags`, 'PUT', {
      tagIds: [considering.id, closed.id],
    });
    expect(saved.status, JSON.stringify(saved)).toBe(200);
    expect((saved.json.data as TagJson[]).map((tag) => tag.id)).toEqual([
      closed.id,
    ]);

    // A second assignment in the same scope replaces the sibling.
    await fx.api(`/v1/leads/${lead.id}/tags`, 'PUT', {
      tagIds: [considering.id],
    });
    const after = await getLead(fx.api, lead.id);
    expect(after.tags.map((tag) => tag.label)).toEqual(['fall26:considering']);

    // The database constraint is the backstop: a raw second same-scope row
    // for the lead is rejected even if application code is bypassed.
    await expect(
      fx.db
        .prepare(
          `INSERT INTO lead_tags (id, workspace_id, lead_id, tag_id, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          '01ARZ3NDEKTSV4RRFFQ69G5FB0',
          WORKSPACE,
          lead.id,
          closed.id,
          considering.scopeId,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
  } finally {
    await fx.dispose();
  }
});

test('rename and delete preserve assignments and reject unsafe moves', async () => {
  const fx = await startFixture();
  try {
    const considering = await createTag(fx.api, 'fall26:considering');
    const closed = await createTag(fx.api, 'fall26:closed');
    const vip = await createTag(fx.api, 'vip');

    const lead = await createLead(fx.api, {
      email: 'rename@example.test',
      firstName: 'Rename',
      source: 'website',
    });
    await fx.api(`/v1/leads/${lead.id}/tags`, 'PUT', {
      tagIds: [considering.id, vip.id],
    });

    const renamed = await fx.api(`/v1/tags/${considering.id}`, 'PATCH', {
      name: 'fall26:interested',
    });
    expect(renamed.status, JSON.stringify(renamed)).toBe(200);
    expect((renamed.json.data as TagJson).id).toBe(considering.id);
    const afterRename = await getLead(fx.api, lead.id);
    expect(afterRename.tags.map((tag) => tag.id)).toContain(considering.id);

    // Moving `vip` (standalone) into fall26 would give this lead two fall26
    // tags; the move must fail and leave both prior assignments intact.
    const conflict = await fx.api(`/v1/tags/${vip.id}`, 'PATCH', {
      name: 'fall26:vip',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('scope_conflict');
    const afterConflict = await getLead(fx.api, lead.id);
    expect(afterConflict.tags.map((tag) => tag.id).toSorted()).toEqual(
      [considering.id, vip.id].toSorted(),
    );

    // Duplicate rename is rejected rather than merged.
    const duplicate = await fx.api(`/v1/tags/${considering.id}`, 'PATCH', {
      name: 'fall26:closed',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.code).toBe('tag_exists');

    // Delete removes only the joins; the sibling tag and lead remain.
    const deleted = await fx.api(`/v1/tags/${considering.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect((deleted.json.data as { removed: number }).removed).toBe(1);
    const afterDelete = await getLead(fx.api, lead.id);
    expect(afterDelete.tags.map((tag) => tag.id)).toEqual([vip.id]);
    const catalog = await fx.api('/v1/tags');
    const catalogData = catalog.json.data as {
      scopes: Array<{ prefix: string }>;
      tags: TagJson[];
    };
    // fall26 still holds its sibling `closed` tag, so the scope survives. The
    // unrelated `source` scope from creation is still present too.
    expect(catalogData.scopes.map((scope) => scope.prefix).toSorted()).toEqual([
      'fall26',
      'source',
    ]);

    // Deleting the final fall26 tag prunes the inferred scope.
    await fx.api(`/v1/tags/${closed.id}`, 'DELETE');
    const pruned = await fx.api('/v1/tags');
    const prunedData = pruned.json.data as {
      scopes: Array<{ prefix: string }>;
      tags: TagJson[];
    };
    expect(prunedData.scopes.map((scope) => scope.prefix)).toEqual(['source']);
    expect(prunedData.tags.map((tag) => tag.id)).toContain(vip.id);
  } finally {
    await fx.dispose();
  }
});

test('scope rename and color update child labels and shared color', async () => {
  const fx = await startFixture();
  try {
    const tag = await createTag(fx.api, 'fall26:considering');
    const scopeId = tag.scopeId as string;

    const recolored = await fx.api(`/v1/tag-scopes/${scopeId}`, 'PATCH', {
      color: 'violet',
    });
    expect(recolored.status, JSON.stringify(recolored)).toBe(200);
    expect((recolored.json.data as { color: string }).color).toBe('violet');

    const renamed = await fx.api(`/v1/tag-scopes/${scopeId}`, 'PATCH', {
      prefix: 'autumn26',
    });
    expect(renamed.status).toBe(200);
    const catalog = await fx.api('/v1/tags');
    const catalogData = catalog.json.data as { tags: TagJson[] };
    const updated = catalogData.tags.find((item) => item.id === tag.id);
    expect(updated?.label).toBe('autumn26:considering');
    expect(updated?.color).toBe('violet');

    // A scope rename onto an existing prefix is rejected.
    await createTag(fx.api, 'spring27:waitlist');
    const collision = await fx.api(`/v1/tag-scopes/${scopeId}`, 'PATCH', {
      prefix: 'spring27',
    });
    expect(collision.status).toBe(409);
    expect(collision.json.code).toBe('scope_exists');
  } finally {
    await fx.dispose();
  }
});

test('list filters by exact tag and scope server-side', async () => {
  const fx = await startFixture();
  try {
    const fall = await createTag(fx.api, 'fall26:considering');
    const spring = await createTag(fx.api, 'spring27:waitlist');
    const vip = await createTag(fx.api, 'vip');

    const first = await createLead(fx.api, {
      email: 'first@example.test',
      firstName: 'First',
      source: 'website',
    });
    const second = await createLead(fx.api, {
      email: 'second@example.test',
      firstName: 'Second',
      source: 'website',
    });
    const third = await createLead(fx.api, {
      email: 'third@example.test',
      firstName: 'Third',
      source: 'website',
    });
    await fx.api(`/v1/leads/${first.id}/tags`, 'PUT', {
      tagIds: [fall.id, vip.id],
    });
    await fx.api(`/v1/leads/${second.id}/tags`, 'PUT', {
      tagIds: [spring.id],
    });

    const exact = await fx.api(`/v1/leads?tag=${fall.id}`);
    expect(
      (exact.json.data as Array<{ id: string }>).map((lead) => lead.id),
    ).toEqual([first.id]);

    const prefix = await fx.api(`/v1/leads?tagScope=${String(fall.scopeId)}`);
    expect(
      (prefix.json.data as Array<{ id: string }>).map((lead) => lead.id),
    ).toEqual([first.id]);

    const none = await fx.api(`/v1/leads?tag=${vip.id}&limit=1`);
    expect(
      (none.json.data as Array<{ id: string }>).map((lead) => lead.id),
    ).toEqual([first.id]);
    void second;
    void third;
  } finally {
    await fx.dispose();
  }
});

test('bulk add replaces same-scope tags and bulk remove is atomic', async () => {
  const fx = await startFixture();
  try {
    const considering = await createTag(fx.api, 'fall26:considering');
    const closed = await createTag(fx.api, 'fall26:closed');
    const vip = await createTag(fx.api, 'vip');

    const first = await createLead(fx.api, {
      email: 'bulk-1@example.test',
      firstName: 'Bulk',
      source: 'website',
    });
    const second = await createLead(fx.api, {
      email: 'bulk-2@example.test',
      firstName: 'Bulk',
      source: 'website',
    });
    await fx.api(`/v1/leads/${first.id}/tags`, 'PUT', {
      tagIds: [considering.id],
    });

    const added = await fx.api('/v1/leads/tags/bulk', 'POST', {
      ids: [first.id, second.id],
      mode: 'add',
      tagIds: [closed.id, vip.id],
    });
    expect(added.status, JSON.stringify(added)).toBe(200);
    expect((added.json.data as { affected: number }).affected).toBe(2);

    const firstAfter = await getLead(fx.api, first.id);
    expect(firstAfter.tags.map((tag) => tag.id).toSorted()).toEqual(
      [closed.id, vip.id].toSorted(),
    );

    const removed = await fx.api('/v1/leads/tags/bulk', 'POST', {
      ids: [first.id, second.id],
      mode: 'remove',
      tagIds: [vip.id],
    });
    expect(removed.status).toBe(200);
    const afterRemove = await getLead(fx.api, second.id);
    expect(afterRemove.tags.map((tag) => tag.label)).toEqual([
      'fall26:closed',
      'source:website',
    ]);

    // A missing lead makes the whole bulk request fail without changes.
    const missing = await fx.api('/v1/leads/tags/bulk', 'POST', {
      ids: [first.id, '01ARZ3NDEKTSV4RRFFQ69G5FBZ'],
      mode: 'add',
      tagIds: [vip.id],
    });
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe('unknown_lead');
    const unchanged = await getLead(fx.api, first.id);
    expect(unchanged.tags.map((tag) => tag.id)).toEqual([closed.id]);
  } finally {
    await fx.dispose();
  }
});

test('intake creates unknown tags, derives source, and replays safely', async () => {
  const fx = await startFixture();
  try {
    const tokenResponse = await fx.api('/v1/tokens', 'POST', {
      expiresAt: null,
      name: 'Tags intake',
      type: 'api',
    });
    expect(tokenResponse.status).toBe(201);
    const token = (tokenResponse.json.data as { token: string }).token;

    const intake = (key: string, body: Record<string, unknown>) =>
      fx.api('/v1/intakes', 'POST', body, {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
      });

    const first = await intake('tags-intake-1', {
      email: 'intake-tags@example.test',
      source: 'Spring_Expo',
      tags: ['campaign:spring', 'vip'],
    });
    expect(first.status, JSON.stringify(first)).toBe(201);
    const leadId = (first.json.data as { leadId: string }).leadId;

    const lead = await getLead(fx.api, leadId);
    expect(lead.tags.map((tag) => tag.label).toSorted()).toEqual(
      ['campaign:spring', 'source:spring_expo', 'vip'].toSorted(),
    );

    const catalogBefore = await fx.api('/v1/tags');
    const countTags = (json: Record<string, unknown>) =>
      (json.data as { tags: TagJson[] }).tags.length;
    const before = countTags(catalogBefore.json);

    // Replaying the identical payload neither creates tags nor changes joins.
    const replay = await intake('tags-intake-1', {
      email: 'intake-tags@example.test',
      source: 'Spring_Expo',
      tags: ['campaign:spring', 'vip'],
    });
    expect(replay.status).toBe(201);
    const catalogAfterReplay = await fx.api('/v1/tags');
    expect(countTags(catalogAfterReplay.json)).toBe(before);
    const replayLead = await getLead(fx.api, leadId);
    expect(replayLead.tags).toHaveLength(3);

    // A changed payload under the same key conflicts and writes nothing.
    const conflict = await intake('tags-intake-1', {
      email: 'intake-tags@example.test',
      source: 'Spring_Expo',
      tags: ['campaign:summer'],
    });
    expect(conflict.status).toBe(409);

    // An explicit source:* tag takes precedence over the derived source.
    const explicit = await intake('tags-intake-2', {
      email: 'explicit-source@example.test',
      source: 'Spring_Expo',
      tags: ['source:referral'],
    });
    expect(explicit.status).toBe(201);
    const explicitLead = await getLead(
      fx.api,
      (explicit.json.data as { leadId: string }).leadId,
    );
    expect(explicitLead.tags.map((tag) => tag.label)).toEqual([
      'source:referral',
    ]);

    // Multiple same-scope tags in one payload: last wins.
    const lastWins = await intake('tags-intake-3', {
      email: 'last-wins@example.test',
      source: 'website',
      tags: ['campaign:spring', 'campaign:summer'],
    });
    expect(lastWins.status).toBe(201);
    const lastWinsLead = await getLead(
      fx.api,
      (lastWins.json.data as { leadId: string }).leadId,
    );
    expect(
      lastWinsLead.tags
        .map((tag) => tag.label)
        .filter((label) => label.startsWith('campaign:')),
    ).toEqual(['campaign:summer']);
  } finally {
    await fx.dispose();
  }
});

test('legacy source values backfill losslessly into a source scope', async () => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: 'tags-regression@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script,
    }),
  );
  try {
    const database = await mf.getD1Database('DB');
    const migrationNames = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    const tagMigration = '0003_classy_emma_frost.sql';
    const before = migrationNames.filter((name) => name < tagMigration);
    expect(before).not.toContain(tagMigration);

    await applyMigrations(database, before);
    const longSource = 'x'.repeat(80);
    await insertLegacyLead(database, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FC0',
      source: 'Website_Form',
    });
    await insertLegacyLead(database, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FC1',
      source: longSource,
    });
    await applyMigrations(database, [tagMigration]);

    const tags = await database
      .prepare('SELECT name, scope_id FROM tags ORDER BY name')
      .all<{ name: string; scope_id: null | string }>();
    expect(tags.results.map((row) => row.name).toSorted()).toEqual(
      [longSource, 'website_form'].toSorted(),
    );
    // The over-length legacy value is preserved in full, not truncated.
    expect(tags.results.some((row) => row.name === longSource)).toBe(true);
    expect(tags.results.every((row) => row.scope_id !== null)).toBe(true);

    const joins = await database
      .prepare(
        'SELECT lead_id, count(*) AS count FROM lead_tags GROUP BY lead_id',
      )
      .all<{ count: number; lead_id: string }>();
    expect(joins.results).toHaveLength(2);
    for (const row of joins.results) {
      expect(row.count).toBe(1);
    }

    // The raw legacy column is untouched.
    const raw = await database
      .prepare('SELECT source FROM leads ORDER BY id')
      .all<{ source: string }>();
    expect(raw.results.map((row) => row.source)).toEqual([
      'Website_Form',
      longSource,
    ]);
  } finally {
    await mf.dispose();
  }
});
