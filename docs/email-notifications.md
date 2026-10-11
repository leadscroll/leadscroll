# Email notifications

LeadScroll can email opted-in staff when a new lead arrives. The feature is
disabled by default and stays inside the installation: no third-party template
service, no tracking pixels, and no contact data in the message. Alerts are
sent only for new leads, never for assignments, tasks, customers, digests, or
campaigns.

## How it works

1. A lead is created through public/API intake or manually in the app. The same
   atomic D1 batch that stores the lead records one durable outbox row per
   opted-in, enabled recipient (the manual creator is excluded).
2. A Cron Trigger wakes the Worker every minute. Each tick records its health,
   recovers abandoned leases, expires stale events, and processes at most one
   due notification. The default of one message per minute keeps CPU and D1
   headroom on Workers Free.
3. The delivery command claims one row with a lease, rechecks the recipient,
   address, preference, and lead, freezes the provider/envelope/hash, and sends.
   Provider, payload, hash, and idempotency key are pinned before the first
   attempt; changed credentials never silently retarget an attempted row.

The email provider never sits on the lead-creation path. A provider outage
cannot fail or slow down intake; it only delays alerts.

## Provider setup

Provider choice is stored in D1 and managed in **Manage → Email**. No provider
or sender environment variables are required.

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
"EMAIL" }]` and redeploy, or keep using Resend.

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

### Cron

Both `wrangler.jsonc` files declare `"triggers": { "crons": ["* * * * *"] }`.
Every tick records scheduler health and runs bounded, indexed lease recovery,
stale-event expiry, and terminal-row cleanup, so a disabled installation still
incurs a small fixed amount of D1 work (roughly one health write plus three
limited statements per minute). Older installations can add the same block and
redeploy.

## Enabling, testing, and pausing

- Saving settings never sends a message. You can save and enable without ever
  running a test; the UI shows **Not tested** until an explicit test runs for
  the current settings.
- An explicit test works even while delivery is paused or the enable switch is
  off, as long as the saved provider configuration is locally complete: testing
  is how a paused revision recovers, and it never turns live alerts on.
  Missing local resources (no binding, no key, no sender) still block the test
  with a specific setup message.
- **Send test email** sends one message to the signed-in administrator's own
  account email using the saved configuration. It is limited to one per minute
  and five per 24 hours per installation, and the request id makes retries
  idempotent.
- Changing provider, sender, or key increments the settings revision. Previous
  test evidence no longer applies to the new revision, but no test is required
  to save or enable.
- A definite provider-configuration failure (for example an invalid key or an
  unverified domain) pauses further attempts for that revision. Correcting the
  settings or completing a successful test resumes sending. Paused is shown
  separately from the enabled preference, and disabling email always works.

## Staff preferences and history

Each account manages its own **New lead emails** opt-in under **Account →
Notifications**; it defaults off and never backfills historical leads.
The account email is the only possible destination. Turning alerts off skips
pending rows at dispatch; a message already accepted by the provider cannot be
recalled.

**Account → Notifications → Delivery history** shows the caller's own rows.
"Accepted by email service" means the provider accepted the message for
delivery — it does not prove inbox delivery or a read.

## Reliability and unknown outcomes

- Accepted rows are never resent.
- Transient rejections retry with bounded backoff (1m, 5m, 15m, 1h, 6h,
  capped by event expiry).
- Resend retries reuse the exact same payload and idempotency key only inside
  its 24-hour window (with a safety margin); after that an unresolved outcome
  stays `unknown`.
- Cloudflare has no documented per-request idempotency, so an ambiguous
  submission is recorded as `unknown` rather than blindly retried.
- Events older than 24 hours are not delivered: never-attempted rows are
  skipped and ambiguous ones remain `unknown`.
- Terminal outbox rows older than 30 days are cleaned up in bounded batches;
  unresolved `unknown` rows are retained for operator reconciliation.
- There is no exactly-once guarantee: D1 and the provider do not share a
  transaction. Duplicate suppression is durable per event/recipient, and the
  provider-specific policies above keep the residual window honest.

Reconcile an `unknown` row with the provider's own logs/message ids before
taking any action. There is deliberately no generic resend endpoint.

## Operators

The first account created with `SETUP_TOKEN` receives the narrow
`manageEmailSettings` capability atomically. On upgrades the migration grants
it to the surviving enabled bootstrap registrant when that identity is
unambiguous. If no administrator exists (for example the bootstrap account was
deleted), an operator grants the capability to one explicit enabled account.

Source checkout:

```sh
pnpm run notifications:grant-admin -- <user-id>            # remote D1
pnpm run notifications:grant-admin -- <user-id> --local    # local D1
```

Copied template installation (the command ships in the copied repository and
is self-contained; no upstream checkout is needed):

```sh
pnpm run notifications:grant-admin -- <user-id>            # remote D1
pnpm run notifications:grant-admin -- <user-id> --local    # local D1
```

Find ids with `wrangler d1 execute DB --remote --command "SELECT id, email,
disabled_at FROM user ORDER BY email"`. The command refuses unknown or disabled
accounts, is idempotent, and never promotes the first account automatically.

## Observability

Every dispatch outcome emits one structured line with the event
`notification.dispatch`, the opaque outbox id, the outcome, the attempt count,
and an allowlisted reason code. It never includes addresses, envelopes, lead
data, or provider response bodies. **Manage → Email → Scheduler** shows the last
tick, waiting/in-flight/unknown counts, the last accepted send, and the current
scheduler error.

Operators can query the same redacted state directly:

```sh
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT status, COUNT(*) FROM notification_outbox GROUP BY status"
pnpm exec wrangler d1 execute DB --remote --command \
  "SELECT last_tick_at, last_success_at, config_error_code, config_error_at FROM notification_dispatch_state"
```

Health thresholds worth watching: a waiting item older than five minutes, no
tick for five minutes while email is enabled, or any `unknown` row.

## Rollback

Disable sending in **Manage → Email** first: no new sends start, pending mail is
paused and expires, and accepted/unknown rows are never auto-resent. Reverting
Worker code is safe with additive tables and migrations in place; do not roll
the schema back destructively. Provider API keys can be revoked at the provider
even though old D1 backups may retain ciphertext.

## Limits and untested assumptions

- Worker/D1/CPU costs are bounded by one message per minute plus one health
  write per tick. Measure before raising the batch size.
- Local configuration checks cannot prove remote entitlement. The standard
  clean-account deployment of the always-present `EMAIL` binding (no Email
  Routing/Sending onboarding) is a release validation step, not something the
  app can prove locally. Until it is verified on a real account, treat the
  default binding as untested deployment behavior; absent-binding installs
  keep working by design.
