#!/usr/bin/env node
/**
 * Operator recovery: grant the narrow manageEmailSettings capability to one
 * explicit, enabled staff account.
 *
 * This command exists for upgraded installations whose bootstrap owner cannot
 * be identified unambiguously (or was disabled/removed). It never promotes a
 * first/latest account, and it fails when the target does not exist or is
 * disabled. The application repository function performs the same check and is
 * covered by the D1 tests; this wrapper only executes the equivalent SQL
 * through Wrangler against the installation's DB binding.
 *
 * Usage:
 *   pnpm run notifications:grant-admin -- <user-id>           # remote D1
 *   pnpm run notifications:grant-admin -- <user-id> --local   # local D1
 *
 * Find the account id with the app's Team members page, or:
 *   pnpm exec wrangler d1 execute DB --remote --command \
 *     "SELECT id, email, disabled_at FROM user ORDER BY email"
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

// The single application workspace seeded by the baseline migration.
const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const usage =
  'Usage: pnpm run notifications:grant-admin -- <user-id> [--local]';

const args = process.argv.slice(2);
const local = args.includes('--local');
const unknown = args.filter(
  (argument) =>
    argument !== '--' && argument.startsWith('--') && argument !== '--local',
);
const userId = args.find((argument) => !argument.startsWith('--'));

if (userId === undefined || unknown.length > 0) {
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}

// The id is interpolated into a quoted SQL literal. Refuse anything that is
// not the restricted character set Better Auth/user ids actually use, so the
// command can never become a SQL-injection vector.
if (!/^[\w-]{1,64}$/u.test(userId)) {
  process.stderr.write(
    'The user id must be 1-64 letters, digits, underscores, or hyphens.\n',
  );
  process.exit(1);
}

const now = Date.now();
const sql = [
  `INSERT OR IGNORE INTO email_settings_permissions (workspace_id, user_id, granted_at, granted_by_user_id)`,
  `SELECT '${DEFAULT_WORKSPACE_ID}', id, ${now}, NULL FROM user`,
  `WHERE id = '${userId}' AND disabled_at IS NULL;`,
  `SELECT changes() AS inserted;`,
  `SELECT COUNT(*) AS enabled_users FROM user`,
  `WHERE id = '${userId}' AND disabled_at IS NULL;`,
  `SELECT COUNT(*) AS grants FROM email_settings_permissions`,
  `WHERE workspace_id = '${DEFAULT_WORKSPACE_ID}' AND user_id = '${userId}';`,
].join(' ');

const wranglerArgs = [
  'exec',
  'wrangler',
  'd1',
  'execute',
  'DB',
  '--json',
  '--yes',
  local ? '--local' : '--remote',
  '--command',
  sql,
];

let output;
try {
  output = execFileSync('pnpm', wranglerArgs, { encoding: 'utf8' });
} catch (error) {
  const stderr = error?.stderr?.toString?.() ?? '';
  process.stderr.write(
    `Wrangler could not run the grant. ${stderr.trim() || 'See the output above.'}\n`,
  );
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(output);
} catch {
  process.stderr.write('Wrangler returned output that was not JSON.\n');
  process.exit(1);
}

const rows = Array.isArray(payload)
  ? payload.flatMap((entry) => entry?.results ?? [])
  : [];
const value = (name) => {
  const row = rows.find((entry) => entry?.[name] !== undefined);
  return row === undefined ? undefined : Number(row[name]);
};

const enabledUsers = value('enabled_users');
const grants = value('grants');
const inserted = value('inserted');

if (!Number.isFinite(enabledUsers) || enabledUsers === 0) {
  process.stderr.write(
    `No enabled account with id ${userId} exists. Grant the capability to a different account.\n`,
  );
  process.exit(1);
}

if (!Number.isFinite(grants) || grants === 0) {
  process.stderr.write(
    'The capability was not granted; no permission row exists.\n',
  );
  process.exit(1);
}

process.stdout.write(
  inserted === 1
    ? `Granted manageEmailSettings to ${userId}.\n`
    : `manageEmailSettings was already granted to ${userId}; nothing changed.\n`,
);
