# Source-built installation and upgrade contract

`templates/cloudflare/` is the installation project copied by Cloudflare's
Deploy button from this repository. Cloudflare's copy omits `.github/workflows`,
so the owner installs a small caller workflow once through a link in the copied
README. The generated repository
owns Wrangler configuration, D1 identity, secrets, the exact upstream source
pin, and a small set of installer scripts; it does not import the parent
workspace.

## Pinned build

`leadscroll.json` records the public upstream `owner/repository` and either a
full 40-character commit or the `main` channel. The shipped template uses
`main`: a build resolves it to the commit `main` names at that moment and
writes that commit into the checkout's `leadscroll.json` for the rest of that
build and deploy. That write is **ephemeral** — Workers Builds does not commit
it back — so as long as the repository records `main`, every later build
re-resolves the channel and can apply newer migrations to the existing D1.
Commit a full SHA, or run Upgrade once, to lock the installation. `pnpm run
build`:

1. Invalidates deploy readiness and acquires the owned `.leadscroll/.lock`.
2. Initializes an isolated temporary Git checkout, fetches the recorded commit
   (or the `main` channel, resolving it to a commit), checks it out detached,
   and verifies `HEAD` equals the resolved revision.
3. Installs the fetched source's dependencies from its `pnpm-lock.yaml` with
   `pnpm install --frozen-lockfile --prod=false`, so compilation tools remain
   available even when the build environment sets `NODE_ENV=production`.
4. Runs the upstream-owned `source:build` command. The template does not duplicate
   Vite, esbuild, Worker-entry, or dependency knowledge.
5. Verifies the Worker, UI, runtime requirements, migration names and hashes, and
   source-commit receipt before atomically promoting generated output.

The build subprocess does not receive known deployment credentials or application
secrets. Installation files and `.dev.vars` are never copied into source. Failed
fetches, installs, builds, runtime checks, and migration checks leave D1 and tracked
configuration untouched and keep deployment blocked until a successful rebuild.

The shipped template pins the `main` channel rather than a fixed commit, so
new installations build the current, CI-green `main` without a manual bump. The
channel is resolved per build in an ephemeral checkout, not committed back, so
an installation left on `main` keeps tracking upstream `main`; commit the
resolved SHA or run Upgrade to freeze it. The current migration history is a
single squashed baseline (`0000_leadscroll_baseline.sql`). Its filename is
unchanged from earlier epochs but its bytes differ, so ordinary history guards
reject a source-pin upgrade from those epochs. Those installations must use the
baseline reset procedure below, not an in-place migration. For existing
installations only, the installer retains a narrow adapter for historical pin
`8c8f7cd...`; it consumes that commit's local build output and never contacts
GitHub Releases.

## Baseline reset epoch

This release squashes migration history to one final-schema baseline. That is a
one-time breaking epoch transition, not an ordinary forward migration:

1. Pause writes and export the existing D1 database. Record the Worker name,
   `DB` binding/name/ID, secrets, and the current source pin.
2. Create a fresh replacement D1 database. Do not apply the new baseline over
   the old database, and do not edit the old `d1_migrations` ledger to make its
   history look different. The shared baseline filename does not mean the old
   ledger's `0000` row describes the new schema.
3. Apply `drizzle/0000_leadscroll_baseline.sql` to the fresh database. Its new
   migration ledger contains only the baseline.
4. Replay the retained business, authentication, token, invitation, and grant
   rows into the final schema. Preserve IDs and values. The final schema has no
   workspaces table or `workspace_id` columns. If the exported installation
   already has accounts or spent grants, preserve its `bootstrap_state` and
   `registration_claims` (or restore the bootstrap row as consumed); do not let
   the fresh seed reopen first-account registration.
5. Verify row counts, foreign keys, authentication, token hashes, idempotency
   replay, tag constraints, and settings. Keep the old database untouched.
6. Deploy the Worker and source pin that match this baseline, with the `DB`
   binding pointed at the replacement database. Keep the old database, old
   code, old pin, and old binding together until the cutover is accepted.

Ordinary `wrangler d1 migrations apply` and Upgrade runs intentionally fail
closed when they see the changed `0000_leadscroll_baseline.sql`; there is no
automatic legacy reset or history bypass. The procedure is operator-led and
requires export, a fresh database, replay, and matching code.

## Optional Upgrade workflow

The copied README links to GitHub's new-file editor for
`.github/workflows/upgrade.yml`. The prefilled content is a small
`workflow_dispatch` caller of the reusable upstream
`.github/workflows/cloudflare-upgrade.yml@main`. GitHub's editor prefill query
parameters are not a documented API, so the copied root
`upgrade-workflow.yml` is a copy/paste fallback. The owner reviews and commits
the file to the installation's default branch once; Cloudflare's copy does not
install it automatically. Future clicks on the README Upgrade button open the
installation's Actions page for a deliberate **Run workflow** click.

The reusable workflow resolves the installation's default-branch SHA, the
installed pin (a SHA, or the `main` channel resolved to the current upstream
`main` SHA), and the exact upstream `main` SHA before candidate execution. It waits up to nine
minutes for exact-SHA upstream push CI to pass; failure or timeout leaves the
pin unchanged. Then it compiles and checks the candidate on a read-only runner,
comparing migrations with the old pinned
source even in a clean checkout. A fresh runner reconstructs only
`leadscroll.json`, rejects a changed base or extra path, and pushes without
force using the caller repository's `GITHUB_TOKEN`. No GitHub App, central
Worker, or Cloudflare credential is required. The caller uses `@main`, so its
manual runs use the current upstream workflow logic. That upstream code has
temporary Contents-write permission in the caller during a run; the owner
should review it, back up D1 first, and confirm the resulting Cloudflare build
and resource identity.

Whether a `GITHUB_TOKEN` pin push triggers Cloudflare's separate GitHub App is
still a live verification gate; local tests cannot establish it.

## Manual pin update

The `main` channel advances only when the commit it names changes; an ordinary
rebuild never advances a recorded SHA. To freeze an installation on a specific
commit, the owner deliberately chooses a full upstream SHA from `main` after its
CI has passed, backs up D1, and compares that candidate with the current
`leadscroll.json` revision.
Check that the old revision is an ancestor of the candidate and that every
published `drizzle/*.sql` file is unchanged. In a separate checkout of the
upstream source, substitute the two full SHAs in:

```sh
git merge-base --is-ancestor OLD_SHA NEW_SHA
git diff --name-status OLD_SHA NEW_SHA -- 'drizzle/*.sql'
```

The first command must succeed. The second may show only added (`A`) migration
files, with names after the old history; modified, deleted, renamed, or reordered
migrations are a stop condition. If the candidate changes the baseline epoch
(for example, the bytes of `0000_leadscroll_baseline.sql` differ), stop and use
the baseline reset procedure instead of a pin update. A clean Cloudflare build
has no old generated receipt to compare against, so this check is required
before changing the pin.

Change only `revision` in the installation's `leadscroll.json` (to a full SHA,
or back to `main` to resume tracking). Optionally run
`pnpm install --frozen-lockfile`, `pnpm run build`, and
`pnpm run deploy:dry-run` in a local installation checkout before committing.
Commit only that file to the Cloudflare-connected branch. Workers Builds uses
the exact new SHA, applies pending migrations to the existing `DB` binding,
and deploys the existing Worker. Check the build and unchanged Worker/D1
identities, secrets, and stored records. This manual alternative requires no
Actions workflow, GitHub App, Release asset, publishing token, or Cloudflare
deploy hook.

## Migration and rollback boundary

Published migration names and contents remain immutable within the current
baseline epoch. The source updater and installer compare a candidate's migration
receipt with the previously prepared receipt when one is available; that check
rejects removal or rewriting and requires appended names to sort after existing
history. A clean build may have no prior receipt, so it cannot prove that an old
database is on the current epoch. In that case use the manual baseline transition
below rather than relying on repository tests or an empty build receipt.

The baseline filename is unchanged across the reset, so an existing
`d1_migrations` row named `0000_leadscroll_baseline.sql` is **not** proof that
the new schema is installed. Do not just repin code or point new code at the old
database; inspect the actual schema or, preferably, use a fresh replacement
database.

Migrations run before Worker deployment and are not part of a cross-resource
transaction. A source pin or Worker-version rollback does not reverse D1. Prefer
additive migrations and staged compatibility; restore a D1 backup or deploy a
compatible corrective revision when database rollback is required.

The squashed baseline is also a compatibility boundary: a database built from
it has no workspaces table or `workspace_id` columns and uses the final
installation configuration key, so an old source pin or Worker cannot serve it.
Cutover uses a fresh database and matching code/pin, not an in-place migration;
plan a maintenance window. If the cutover or deployment fails, restore the old
database together with the old code, pin, and binding, or deploy a revision
compatible with the replacement database. Disabling features or rolling back
only the Worker does not reverse the database epoch.

## Existing full-source snapshot installations

For this baseline epoch, do not reuse the old migration ledger or old database.
Export and create a fresh replacement database first, then migrate the
repository. Keep the old Worker, database, code, and pin together for rollback:

1. Back up D1 and record the Worker name, `DB` binding/name/ID, build settings,
   runtime variables, and secrets. Keep the old Cloudflare resources.
2. Export the data. Create a fresh replacement D1 database and apply
   `drizzle/0000_leadscroll_baseline.sql` to it.
3. Replace application source/build files with the isolated template while
   preserving deployment-specific Wrangler values. Adopt the template's Worker
   entry, assets path, and migrations path, and point `DB` at the replacement
   database.
4. Replay the retained business, authentication, token, invitation, and grant
   data into the final schema. Preserve IDs, values, and spent bootstrap/claim
   state; verify foreign keys and application invariants.
5. Install with the frozen template lockfile, build the pinned source, and run
   `pnpm run deploy:dry-run`.
6. Point the existing Workers Build at `pnpm run build` / `pnpm run deploy`, then
   deploy to the same Worker with the replacement `DB` binding. Retain the old
   database and matching old code/pin until the cutover is accepted.

Do not try to reconstruct the old SQL migration history in the replacement
database. After this epoch is established, future updates must preserve the
baseline and append only new migrations.

## Email notification runtime

Generated source builds preserve the Worker's `fetch` handler and its execution
context argument, which is how best-effort notification work is scheduled with
`ctx.waitUntil` after a lead commits. There is no `scheduled` handler and no
Cron trigger: notification delivery is event-driven and best-effort. Standard
templates declare the native `EMAIL` binding in `wrangler.jsonc`; older/custom
installations may need to add it. The optional `EMAIL_SETTINGS_ENCRYPTION_KEY`
secret is needed only to store a Resend API key through the UI and survives
source-pin changes as a Worker secret; replacing the Worker recreates secrets
and requires re-entering provider keys. See the upstream
`docs/email-notifications.md` for setup, best-effort limits, rollback, and
operator recovery.

## Verification boundary

Local integration uses actual pinned Git checkouts, frozen installs, real Worker/UI
compilation, HTTPS workerd, local D1, Chromium, and Wrangler deployment dry-runs.
It exercises two controlled commits, an additive migration, persistent application
and authentication state, idempotent rebuild/upgrade, unreachable revisions, and
rewritten migration rejection.

Before claiming the complete installation experience, run these live gates on an
approved disposable target:

1. Generate a repository through the Cloudflare folder button and confirm it
   contains `leadscroll.json`, the README's workflow setup link, and the root
   fallback YAML. The absence of `.github/workflows` is expected.
2. Inspect the Cloudflare application already created by the folder button;
   do not import the repository again. Confirm D1 provisioning occurs before
   migrations/deployment, set the two runtime secrets, and redeploy that
   existing application. Import a repository only when it was created without
   the Deploy button.
3. On an approved disposable installation, use the setup link to commit the
   caller workflow, then run Upgrade. Confirm its pin-only `GITHUB_TOKEN` commit
   triggers Workers Builds while the Worker name, D1 name/ID, secrets, and
   stored records remain unchanged. Test the manual pin-edit fallback too.

Mocks and local Git repositories are not evidence for those platform behaviors.

The former dedicated GitHub template repository is not part of this installation
path. It need not be deleted to use the Cloudflare folder button; deleting it is
a separate owner decision.
