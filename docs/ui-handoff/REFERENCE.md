# Approved demo reference

Reference commit: `c0ffdaacc9f7e3565a605b32a5e884ca100555e5`.
Source worktree (read only):
`/mnt/data/projects/cloudflare-lead-desk/gigs/2026-10-06-ui-design-slice/worktree`.

Live preview (temporary tunnel):
- https://tattoo-reliable-walks-depth.trycloudflare.com/leads
- https://tattoo-reliable-walks-depth.trycloudflare.com/leads/preview-lead-1
- https://tattoo-reliable-walks-depth.trycloudflare.com/settings/tags
- https://tattoo-reliable-walks-depth.trycloudflare.com/settings/tokens
- https://tattoo-reliable-walks-depth.trycloudflare.com/preview/toasts

All live demo data is fictional. Tag changes are browser-memory state and reset
on reload. The tunnel may expire; the frozen package below is the durable reference.

## Frozen package

Absolute directory:
`/mnt/data/projects/cloudflare-lead-desk/gigs/2026-10-07-ui-production/artifacts/reference`.

- `approved-demo.tar.gz`: tracked source archive at the approved commit.
- `approved-ui.patch`: exact diff from the production base to the reference.
- `serve.mjs`: isolated fake-API launcher, adapted to the archive directory.
- `screenshots/`: selected final screenshots, not early iterations.
- `SHA256SUMS`: integrity manifest for the reference files.

To recreate locally, from the reference directory:

```sh
mkdir -p demo
tar -xzf approved-demo.tar.gz -C demo
cd demo
pnpm install --frozen-lockfile
cd ..
node serve.mjs
```

Default port is 4183. Set `LEADSCROLL_DEMO_PORT` to use another local port. The
launcher binds to loopback, has no real auth or credentials, and does not contact
production. Do not copy it or its sample data into the production app.

The existing live preview uses port 4173 and is managed by the root agent. The
implementation worker must use different local ports and disposable databases.

## Source map

- src/styles.css: exact design tokens, controls, layout, tag and toast treatment.
- src/components/: shell, brand, header, shared controls and inline validation.
- src/leads/: approved list/detail/create composition.
- src/design-preview/tags/: interaction reference only; replace memory data owner.
- src/lib/tokenFormValues.ts and TokenExpirationField: approved expiration behavior.
- public/brand/leadscroll-mark.svg: original user logo, unchanged.

Screenshots and code are complementary: use the running reference for interactions
and the frozen source to resolve dimensions/tokens. Latest HANDOFF.md decisions
supersede earlier research suggestions and chronological gig notes.
