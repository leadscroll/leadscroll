#!/usr/bin/env node
/**
 * Standalone operator recovery for a copied LeadScroll installation.
 *
 * Grants the narrow manageEmailSettings permission to one explicit enabled
 * account. It is intentionally self-contained (no parent-repository imports)
 * and executes the same safety-guarded SQL as the source checkout command
 * through the installation's own Wrangler and `DB` binding.
 *
 * Usage (from the copied installation repository):
 *   pnpm run notifications:grant-admin -- <user-id>            # remote D1
 *   pnpm run notifications:grant-admin -- <user-id> --local    # local D1
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// The single application workspace seeded by the baseline migration.
const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

export const usage =
  'Usage: pnpm run notifications:grant-admin -- <user-id> [--local]';

/**
 * Builds the atomic grant SQL. The INSERT only selects an enabled account by
 * explicit id; the follow-up SELECTs let the caller distinguish granted,
 * already granted, disabled, and missing without a second round trip.
 */
export const buildGrantSql = (userId, now = Date.now()) =>
  [
    `INSERT OR IGNORE INTO email_settings_permissions (workspace_id, user_id, granted_at, granted_by_user_id)`,
    `SELECT '${DEFAULT_WORKSPACE_ID}', id, ${now}, NULL FROM user`,
    `WHERE id = '${userId}' AND disabled_at IS NULL;`,
    `SELECT changes() AS inserted;`,
    `SELECT COUNT(*) AS enabled_users FROM user`,
    `WHERE id = '${userId}' AND disabled_at IS NULL;`,
    `SELECT COUNT(*) AS grants FROM email_settings_permissions`,
    `WHERE workspace_id = '${DEFAULT_WORKSPACE_ID}' AND user_id = '${userId}';`,
  ].join(' ');

const value = (rows, name) => {
  const row = rows.find((entry) => entry?.[name] !== undefined);
  return row === undefined ? undefined : Number(row[name]);
};

/**
 * Maps Wrangler's JSON output onto a safe operator-facing result.
 */
export const interpretGrantOutput = (payload) => {
  const rows = Array.isArray(payload)
    ? payload.flatMap((entry) => entry?.results ?? [])
    : [];
  const enabledUsers = value(rows, 'enabled_users');
  const grants = value(rows, 'grants');
  const inserted = value(rows, 'inserted');
  if (!Number.isFinite(enabledUsers) || enabledUsers === 0) {
    return {
      code: 'not-found',
      message:
        'No enabled account with that id exists. Grant the permission to a different account.',
      ok: false,
    };
  }

  if (!Number.isFinite(grants) || grants === 0) {
    return {
      code: 'not-granted',
      message: 'The permission was not granted; no permission row exists.',
      ok: false,
    };
  }

  return inserted === 1
    ? { code: 'granted', message: 'Granted manageEmailSettings.', ok: true }
    : {
        code: 'already-granted',
        message: 'manageEmailSettings was already granted; nothing changed.',
        ok: true,
      };
};

const wranglerCommand = () => {
  const localBinary = join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  );
  return existsSync(localBinary) ? localBinary : 'wrangler';
};

const main = () => {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const local = args.includes('--local');
  const unknown = args.filter(
    (argument) =>
      argument !== '--local' && argument.startsWith('--') && argument !== '--',
  );
  const userId = args.find((argument) => !argument.startsWith('--'));
  if (userId === undefined || unknown.length > 0) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
    return;
  }

  if (!/^[\w-]{1,64}$/u.test(userId)) {
    process.stderr.write(
      'The user id must be 1-64 letters, digits, underscores, or hyphens.\n',
    );
    process.exitCode = 1;
    return;
  }

  const sql = buildGrantSql(userId);
  let output;
  try {
    output = execFileSync(
      wranglerCommand(),
      [
        'd1',
        'execute',
        'DB',
        '--json',
        '--yes',
        local ? '--local' : '--remote',
        '--command',
        sql,
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? '';
    process.stderr.write(
      `Wrangler could not run the grant. ${stderr.trim() || 'See the output above.'}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    process.stderr.write('Wrangler returned output that was not JSON.\n');
    process.exitCode = 1;
    return;
  }

  const result = interpretGrantOutput(payload);
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return;
  }

  process.stderr.write(`${result.message}\n`);
  process.exitCode = 1;
};

if (process.argv[1] === import.meta.filename) {
  main();
}
