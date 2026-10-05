# Contributing

Thanks for improving Cloudflare LeadScroll.

1. Read the architecture decisions in `docs/adr`.
2. Keep HTTP contracts in Effect Schema; do not add a second validator.
3. Keep Drizzle inside D1 repositories and business rules in Effect commands.
4. Add tests for changed behavior and run `pnpm run check` before opening a pull request.
5. Never edit or delete an applied migration; add a new migration on top. D1 records applied migrations by filename, so a rewritten file silently diverges from every database that already ran it. The release/upgrade path verifies append-only history with migration digests.
6. Do not copy code, product copy, UI assets, or screenshots from Attio, HubSpot, Twenty, or other products used as references.
7. React components: one component per file, and the file name matches the component name starting with a capital letter. Extract subcomponents into their own files. When the subcomponents are specific to one component, give that component a folder (`ComponentName/index.tsx`) and keep its subcomponents beside it; shared components live in `src/components`.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Backlog

GitHub Issues is the project backlog. Deferred work recorded in a gig's
`NOTES.md` must be filed as an issue and linked from there — the issue is the
durable record, the note only points at it.

- Use `tech-debt` (structural, not user-visible), `security`, `potential`
  (worth doing if the product signal appears), or `blocked` (waiting on an
  external dependency or a decision), in addition to the existing labels.
- Prefix titles with the area: `[api]`, `[ui]`, `[sdk]`, `[ci]`, `[datetime]`,
  `[search]`, `[deps]`.
- Reference the issue from the PR that resolves it (`Closes #NN`) and close it
  when that PR merges.
