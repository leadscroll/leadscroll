# Email notifications

LeadScroll can email opted-in staff when a new lead arrives. The feature is
disabled by default and stays inside the installation: no third-party template
service, no tracking pixels, and no contact data in the message. Alerts are
sent only for new leads, never for assignments, tasks, customers, digests, or
campaigns.

## How it works

1. A lead is created through public/API intake or manually in the app. The
   shared lead service returns only after the lead's atomic D1 batch has
   committed.
2. The application command then publishes a small typed `lead.created` event
   carrying the lead id and the creator (null for intake). Replays, idempotency
   conflicts, validation failures, and failed transactions publish nothing.
3. A fixed email subscriber reads the current installation configuration and
   the current opted-in, enabled staff, excludes the manual creator, checks the
   lead still exists, and sends one generic message per recipient through the
   saved provider.
4. The subscriber runs on the Worker's `ctx.waitUntil`, so it never delays the
   HTTP response. It uses a small concurrency limit (4), an overall background
   budget (20 seconds), and a per-provider-call timeout (10 seconds).

Delivery is **best-effort by design**. There is no outbox, queue, Cron trigger,
retry engine, replay/reconciliation, or delivery history. A Worker
interruption, a crash between the commit and publication, a provider timeout,
or a provider rejection can lose an alert. There is no exactly-once claim. A
timeout may still have been accepted by the provider, so nothing is ever
automatically resent. A future queue can wrap the event boundary without
changing the lead service or the subscriber; that infrastructure is
deliberately not built yet.

## Provider setup

Provider choice is stored in D1 and managed in **Manage → Email**. No provider
or sender environment variables are required. Email settings and the
encrypted provider credential live in one installation-wide JSON
document (`installation_config`) that the application validates on every read
and before every write; compact, bounded test state (the last result plus a
small rolling rate-limit window) lives in the same document. A missing record
means disabled defaults; a corrupt or unsupported document fails closed and is
never silently reset.

### Cloudflare Email Sending

1. The installation must be on a Workers Paid plan and have a sender domain
   onboarded for Email Sending.
2. Standard installations declare the native `EMAIL` binding in
   `wrangler.jsonc`; it is invoked only when Cloudflare is the saved provider.
   Switching to/from Resend needs no redeploy.
3. In **Manage → Email**, select Cloudflare, enter the sender address and name,
   then save and enable. Sending a test is recommended but never required:

   > Cloudflare email sending requires a Workers Paid plan. We recommend
   > sending a test email to confirm your setup.

Older/custom installations without the binding report
`cloudflare_binding_missing`; the owner can add `"send_email": [{ "name":
"EMAIL" }]` and redeploy, or keep using Resend. The Cloudflare binding has no
documented per-request idempotency and cannot be canceled, so a timeout is
reported as unknown and left alone.

### Resend

1. Create a send-only API key and verify the sending domain in Resend. Free
   plans list 3,000 emails/month and 100/day, shared with other use of that
   Resend account; fan-out counts per recipient.
2. Provision the optional credential-encryption secret once:

   ```sh
   openssl rand -base64 32 | pnpm exec wrangler secret put EMAIL_SETTINGS_ENCRYPTION_KEY
   ```

   The base CRM still needs only `BETTER_AUTH_SECRET` and `SETUP_TOKEN`; this
   key is required only for storing Resend API keys through the UI. It is never
   stored in D1, never derived from the auth secret, and never sent to the
   browser. Back it up: without it, stored credentials cannot be decrypted and
   must be re-entered (or the old key must be restored).
3. In **Manage → Email**, select Resend, enter the sender address and name, and
   paste the API key. The key is encrypted with AES-256-GCM before storage and
   is never returned by the API. Keep, replace, and remove are explicit
   actions; removing the key that backs the selected provider disables Resend
   atomically.

## Enabling and testing

- Saving settings never sends a message. You can save and enable without ever
  running a test; the UI shows **Not tested** until an explicit test runs for
  the current settings.
- An explicit test works even while the enable switch is off, as long as the
  saved provider configuration is locally complete. Missing local resources
  (no binding, no key, no sender) still block the test with a specific setup
  message.
- **Send test email** sends one attempt to the signed-in staff account's own
  account email using the saved configuration and reports accepted, rejected,
  or unknown honestly. It is limited to one per minute and five per rolling
  24 hours per installation; only the most recent request id is retained for
  own-actor double-click deduplication, so this is finite duplicate protection
  rather than durable idempotency. There is no automatic retry or
  frozen-payload replay: sending another test is always an explicit staff
  action with a new request id.
- Changing provider, sender, or key increments the settings revision. Previous
  test evidence no longer applies to the new revision, but no test is required
  to save or enable.
- A provider rejection is recorded with a redacted reason code and shown for
  the current revision. It never pauses the installation: correct the settings
  (or disable email) and the next event uses the new configuration.

## Staff preferences

Each account manages its own **New lead emails** opt-in under **Account →
Notifications**; it defaults off and never backfills historical leads. The
account email is the only possible destination, and the manual creator is
excluded from their own alert. There is no per-recipient delivery history:
every send is best-effort.

## Bounded work

The subscriber never fans out without limit:

- At most 4 provider calls run at once.
- The whole subscriber run is bounded by a 20-second budget below the Worker
  `waitUntil` lifetime. The budget clock starts when the event reaches the
  subscriber, so configuration, lead, and recipient reads and credential
  decryption consume it. Those D1 and WebCrypto operations cannot be canceled;
  if preparation stalls, the budget can be exhausted before the first send, and
  the per-send check then reports the remaining recipients as skipped rather
  than launching work.
- Each call gets the smaller of a 10-second provider timeout and the remaining
  budget. Resend requests are aborted on timeout. The Cloudflare binding cannot
  be canceled: a timeout is recorded as unknown, and no further recipients are
  launched for that event (an already-running call may still finish and its
  outcome is unknown).
- Recipients that were not attempted because the budget ran out are reported as
  skipped with `budget_exhausted`; recipients not launched after a Cloudflare
  timeout are included in the skipped count with reason `cloudflare_timeout`.
  They are not silently dropped and they are not retried.

## Observability

Every subscriber run emits one bounded structured line with the event
`notification.event`: the event kind, the opaque lead id, the outcome
(`delivered`, `failed`, or `skipped`), recipient counts, the selected provider,
and an allowlisted reason code. Dispatcher failures emit a separate
`subscriber_failed` or `scheduling_failed` line with the error class only. No
addresses, envelopes, lead payloads, API keys, or provider response bodies are
ever logged.

Operators can inspect the persisted configuration and the redacted audit trail
directly. The configuration is one JSON document per workspace, validated by
the application schema on read; never edit it by hand while the Worker is
serving requests, and never paste a provider key into a SQL command:

```sh
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT json_extract(document_json, '$.revision') AS revision, \
          json_extract(document_json, '$.email.provider') AS provider, \
          json_extract(document_json, '$.email.enabled') AS enabled, \
          json_extract(document_json, '$.email.from_email') AS from_email \
   FROM installation_config"
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT action, resource_type, created_at FROM audit_log ORDER BY created_at DESC LIMIT 20"
```

Every enabled authenticated staff account can manage the installation email
configuration; there is no per-account permission to grant or recover. The
generic `audit_log` records configuration changes (who, when, safe before/after
values) and explicit test outcomes; credentials are recorded only as
`stored`/`replaced`/`removed` markers, never as ciphertext or plaintext.

There is no scheduler to monitor and no delivery-status table to reconcile.

## Upgrade note

Migration `0004_email_notifications.sql` creates exactly three tables:
`installation_config` (the singleton typed JSON document, including the
document revision, the encrypted provider credential, and compact test state),
`audit_log` (the reusable who-changed-what log), and the existing
`notification_preferences` per-user opt-in. Existing CRM data and migrations
remain unchanged. No outbox, scheduler state, or Cron is needed.

## Rollback

Disabling sending stops future lead events from starting new sends, but a
subscriber snapshot that was already running may still finish its in-flight
sends; the change is not retroactive and does not cancel work. The schema is
forward-only: once `0004` has been applied, rolling back to Worker code that
expected the old email-specific tables requires a version compatible with the
new schema or restoring the database from a backup taken before the upgrade.
Provider API keys can be revoked at the provider even though old D1 backups may
retain ciphertext.

## Limits and untested assumptions

- Local configuration checks cannot prove remote entitlement. The standard
  clean-account deployment of the always-present `EMAIL` binding (no Email
  Routing/Sending onboarding) is a release validation step, not something the
  app can prove locally. Until it is verified on a real account, treat the
  default binding as untested deployment behavior; absent-binding installs
  keep working by design.
- Best-effort delivery is an explicit product tradeoff. If missed alerts become
  unacceptable, add a queue at the event boundary; do not restore the removed
  state machine piecemeal.
