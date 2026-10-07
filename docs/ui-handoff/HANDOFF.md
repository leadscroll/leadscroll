# Approved LeadScroll UI: production handoff

## Objective and ownership

Implement the user-approved design against real persisted application state and
open one reviewable PR after lead review. The user approved implementation,
Pi/DeepSeek delegation, a monitoring heartbeat, review/fixes, and PR creation.
Do not merge or deploy to production.

Working repository: this worktree on `feature/approved-ui`.
Base: `f04dff0fd35f0aa75081e227c2b12f50afae10c1` (origin/main, fetched 2026-10-07).
Approved reference: `c0ffdaacc9f7e3565a605b32a5e884ca100555e5` on `feature/ui-design-slice`.
Reference worktree (read-only):
`/mnt/data/projects/cloudflare-lead-desk/gigs/2026-10-06-ui-design-slice/worktree`.
Durable package:
`/mnt/data/projects/cloudflare-lead-desk/gigs/2026-10-07-ui-production/artifacts`.

The implementation agent owns source changes and tests. The lead owns integration
review, fixes for major findings, remote push and PR. Do not alter the reference
worktree, its preview/tunnel, other gigs, or the canonical repo checkout.

## Approved behavior (latest decisions supersede old prototype notes)

- React/Vite workbench; charcoal surfaces; original user logo; muted apricot accent.
- Compact sidebar, breadcrumbs, toolbar and list; reusable semantic tokens/controls.
- Lead detail is one vertical record: identity, tags, details/raw intake payload,
  then activity. Bounded content width and one document scrollbar at all sizes.
- Quiet filled tags, no decorative dots. Shared scope colors and standalone colors.
- Every `prefix:value` is exclusive within that prefix. No configurable exception,
  pipelines, managed workflows, scope-creation wizard, or token-specific tag policy UI.
- Tag catalog: compact expandable scope rows, searchable, New tag primary action.
  Create a full name; scope is inferred/created. Scope swatch changes child colors.
  Each tag has Rename/Delete; rename preserves assignments; delete states affected
  lead count and leaves siblings/leads. Scope rename preserves identities.
- Duplicate renames are rejected inline; merging is not part of this iteration.
  A move into another scope must not silently discard conflicting assignments.
- Lead tags start read-only. Click to edit a local chip-input draft; Save tags and
  Cancel are separate from contact Save changes. Save commits and shows success;
  Cancel/navigation discards draft. Saving tags must not reset contact drafts.
- Chip picker: one searchable list, selected chips with ×; a scoped choice replaces
  its sibling in the draft. Escape dismisses without clearing selection. Keyboard
  and mobile interaction must work. No per-scope radio sections or No tag rows.
- Support bulk tag add/remove and exact-tag/prefix list filtering.
- Source is presented as a tag, e.g. source:website; no standalone source UI field.
  Existing source values/API clients require a compatibility path (below).
- For now, incoming payloads may supply any tag, including unknown catalog names.
  No token-level fixed-tag/allowlist/creation-permission settings. This changes
  classification input, not the token's authority to read or mutate existing leads.
- Token expiration: 7/30/90 days, Never, Custom date; default 90. Only custom reveals
  datetime + timezone. Preset summary and request use the same reference instant;
  Never sends null. Keep custom future/DST validation and preserve its draft.
- Submit actions enabled for incomplete/unchanged forms; invalid input is explained
  inline and focuses the first invalid control. No validation toasts/native bubbles.
  Keep pending locks and labels. Unchanged save gives inline feedback and no write.
- Success/request notifications use approved dim tinted surfaces, crisp status border,
  tight static glow, and inside-right close control. Keep actionable form errors inline.
- List footer shows count and Load more when applicable; no All caught up copy.

## What the demo is NOT

`src/design-preview/tags` uses browser-memory data and fictional lead IDs. Its API
harness is outside the repo. Refresh loses tags. These are visual/interaction
references, not production persistence or authorization. The toast gallery is a
preview tool. Never enable demo data/routes with a production flag as a shortcut.
Port/reuse the approved components, but replace their data owner with typed API +
TanStack Query. Keep actual auth, raw payload visibility, request handling, account
management, invitation flow, soft deletion and source-distribution behavior.

## Implementation stages

### 1. Adopt the UI foundation

Read AGENTS.md, the shared /mnt/data/AGENTS.md, DESIGN_GUIDELINES.md, and REFERENCE.md.
Review the diff `origin/main..c0ffdaa`; it can be used as a starting point because
main has the same base. Reuse our own assets/styles/components; avoid redesigning
approved surfaces. Remove demo-specific routes/imports from production paths.
Consolidate styles and components where useful without a broad framework rewrite.
Preserve the original SVG and its provenance. Keep Node/pnpm and the lockfile.

### 2. Implement persisted tag/scopes domain

Use Effect schemas for public contracts, Effect commands for business rules,
Drizzle/raw SQL only inside the existing repository boundary and database port.
Add forward-only D1 migration(s); never edit an existing migration.

Persist stable tag IDs, normalized names, optional scope ownership, shared scope
color, standalone color, and lead assignments. Enforce per-workspace uniqueness.
A database constraint plus atomic writes must prevent two values in the same scope
on one lead; do not rely only on frontend filtering or read-before-write checks.
Color choices match the reference palette. Scope identity survives renaming.

Use the demo's canonical full-name parsing for ordinary new tags (trim/case handling,
one scope delimiter, 30-character prefix/40-character value); keep lossless compatibility
for historical source values rather than blindly rejecting/dropping/truncating them.
If an exceptional legacy value requires a migration policy not established here,
report a concrete example and options to the lead before destructive handling.
Use bounded request shapes/counts, but no arbitrary allowlist of tag names.

Required operations: catalog list/create/rename/delete; scope color/rename;
standalone color; lead assignment replacement; bulk add/remove; exact/prefix filter.
The precise endpoint layout is the worker's choice, consistent with current API.
Document it and derive types from the Effect schemas; no untyped parallel contract.

Deleting a tag removes only its joins. Counts must reflect active accessible leads.
Empty inferred scopes may be removed when their final tag is deleted. Do not remove
lead records as a side effect. Catalog move/rename conflicts return a useful error,
with all prior assignments unchanged. Treat bulk failures explicitly and atomically
within the existing request limits; do not report a silent partial success.

### 3. Integrate intake and legacy source safely

Add an optional `tags: string[]` classification input for API/browser intake and
manual creation as appropriate. Unknown incoming tags/scopes are created under the
same domain rules; any named tag is permitted. Normalize/deduplicate; when an input
contains several values for a scope, use deterministic last-in-payload-wins semantics
and test/document that behavior. Preserve raw payload separately.

Intake remains create-only. Public browser tokens must not gain catalog management,
lead update, bulk mutation, read or delete access. Staff endpoints retain all existing
auth/CSRF/content-type checks. No production credential changes.

Preserve old `source` clients and database data. Backfill/map legacy source to a
source:* tag; source aliases are not grounds to drop information. Keep the legacy
column/API compatibility where needed, hide its separate UI. If explicit source:*
tags are supplied, they take precedence over a derived source classification.
Do not destructively drop source in this PR. Keep token/origin provenance and raw
intake payload truthful and independent of later editable classifications.

Include tag creation/assignments in the existing atomic intake/idempotency path.
A replay must not create more tags/leads or alter assignments. A changed tag payload
under an existing idempotency key must conflict according to current fingerprint
semantics. Failures roll back all associated writes. Keep current limits and logging.
Update the browser SDK/docs to support tag input without breaking existing forms.

### 4. Wire the production UI

Replace the memory provider with server data, loading/error states and mutations.
No fake IDs, unpersisted catalog changes or MODE guards for actual tag functionality.
List filtering must operate server-side before pagination; never filter only loaded
rows. Return enough tag/scope information to render without an N+1 query pattern.
Invalidate affected detail/list/catalog queries after writes. Preserve dirty drafts.
Catalog actions and the lead Save tags transaction must behave exactly as approved.

Carry over inline validation without weakening server validation, auth submit locks,
password handling, timezone rules or expiry null-vs-omitted semantics. The generic
Form/Field prototype deserves review: preserve refs, accessibility, native constraint
semantics, correct focus, and no unintended GET submission or credential leakage.

### 5. Verification and delivery

Run `pnpm run check` and `pnpm run build`. Also run the existing SDK/source/distribution
checks when touching SDK/migrations/source builds. Read the Wrangler skill before
running Wrangler; perform local/dry-run checks, not a remote deployment. Validate
migrations against a disposable local database with representative legacy data.

Test server-side: authorization boundaries; scoped exclusivity (including concurrent
writes); create/replay/conflict rollback; rename/delete assignment integrity; source
backfill/compatibility; new intake tag creation; filtered keyset pagination and counts.

Test real UI against the local real API: catalog CRUD/colors; scope replacement;
Save/Cancel tags; dirty contact preservation; bulk changes; raw payload; tag filters;
creation/expiry payloads; inline validation/focus; auth/account forms; desktop/mobile.
Demo-mocked browser checks alone are insufficient for persistence claims.
Keep screenshots/logs in this gig's artifacts. Do not put real customer data there.

Commit in reviewable stages. Write ../artifacts/IMPLEMENTATION_REPORT.md with changed
files, decisions, commands/results, remaining risks, migration behavior, and commit
SHAs. Send the lead a completion notification. Do NOT push, create PR, merge or
publicly deploy; the lead will review/fix and publish the PR as requested.

## Excluded scope

No pipelines/workflows, token tag-rule UI, tag merging/archiving, new permission
system, redesign of unrelated products, package-manager migration, destructive
source-column removal, production data/secret changes, or copied third-party assets.

## Lead review and PR gate

Review security, logic/integration and code quality against this document; fix major
findings and rerun affected checks. PR must include the exact feature branch's button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/leadscroll/leadscroll/tree/feature/approved-ui/templates/cloudflare)

State real validation results and known limits. No merge without explicit user instruction.
