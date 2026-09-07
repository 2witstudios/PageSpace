# Dev-server preview: turning it on

The dev-server preview ships **dark**. Every layer fails closed on a missing
variable, so a half-configured deployment shows nothing rather than something
wrong. This is the list of what has to be true, in order, and what is still
undecided.

Preview apex: **`pagespace.io`** — chosen because it shares no registrable
domain with `pagespace.ai`. A dev server's own JavaScript running on
`preview.pagespace.ai` could set `Domain=.pagespace.ai` cookies and toss
cookies at the dashboard; a separate registrable domain makes that
impossible rather than merely discouraged.

## 1. The edge

`PageSpace-Deploy` PR #27 (`pu/dev-preview-ingress`) adds two host-matched
blocks on `*.preview.{$DEV_PREVIEW_APEX}` to `fly/Caddyfile.fly`:

- WebSocket upgrades → `pagespace-realtime.flycast` (the HMR tunnel; a Next
  route handler cannot carry an upgrade).
- Everything else → `pagespace-web.flycast` (the authenticated proxy, which
  re-runs the drive/session gate on every request).

Both are matched **before** the dashboard's own routing, so a preview request
never falls through to the auth redirect and never picks up the app's security
headers — `X-Frame-Options: DENY` would break the pane, and the preview
response carries its own `frame-ancestors`.

Merge that PR and deploy `pagespace-proxy`.

## 2. Environment

Set the same apex on every app that participates. There is no default
anywhere: an app that misses the variable keeps the feature dark, which is the
failure mode you want.

```
fly secrets set --app pagespace-proxy    DEV_PREVIEW_APEX=pagespace.io
fly secrets set --app pagespace-web      DEV_PREVIEW_APEX=pagespace.io DEV_PREVIEW_ENABLED=true
fly secrets set --app pagespace-realtime DEV_PREVIEW_APEX=pagespace.io DEV_PREVIEW_ENABLED=true
```

`SANDBOX_SESSION_SECRET` must already be set on web and realtime: the preview
cookie's signing key is derived from it, and rotating it invalidates every
live preview cookie at once (which self-heals through the re-mint path).

## 3. DNS and TLS

```
# wildcard A/AAAA (or CNAME) record
*.preview.pagespace.io  →  the proxy app

fly certs add "*.preview.pagespace.io" -a pagespace-proxy
```

A wildcard certificate is DNS-01 only, so delegate `_acme-challenge` per Fly's
documentation and wait for the certificate to verify before step 4.

### A note on the migration

`0287` adds a NOT NULL `sessionId` to `dev_preview_grants` and **clears the
table first**. That is deliberate and costs nothing: a grant is a single-use
sixty-second handshake token, so the worst any holder sees is "this preview
link has expired, reopen the preview from PageSpace", and the next click mints
a fresh one. Without the clear the migration would fail outright (23502) on
any database that has ever held a grant — and all pending migrations run in
one invocation, so it would take the whole release with it.

## 4. The cron

`docker/cron/crontab` already carries the backstop sweep
(`/api/cron/reconcile-dev-previews`, every five minutes). It no-ops while the
feature is dark, so nothing about it needs sequencing.

## 5. The browser smoke

`apps/e2e/tests/21-dev-preview.spec.ts`. It skips itself unless
`E2E_SANDBOX=1`, and skips again if `/api/dev-preview/capability` reports the
feature dark, so it can be left in the suite safely. It covers the whole
journey: session → dev server in the sandbox → the affordance appearing on its
own → Preview → the app rendering through the preview origin → an edit
hot-reloading the frame → open-in-new-tab minting its own grant; plus the
unlisted-port consent path and the revoked-session cutoff.

```
E2E_SANDBOX=1 E2E_BASE_URL=https://<target> bun run --filter '@pagespace/e2e' test:e2e -- 21-dev-preview
```

It also covers the `allowedHosts` case in both directions. The preview reaches
the dev server through PageSpace's hostname, and Vite 6+ rejects a `Host` it
does not know, so the spec starts a server without the allow-list first and
records what the user actually sees, then starts one with
`server.allowedHosts` and asserts the app renders.

### Verify this against a real sprite before the flag goes on

The proxy authenticates to the sprite edge with the **org-scoped Sprites
bearer token** (`preview-forward.ts`, and the WebSocket tunnel does the same),
and the in-sprite relay is a byte-for-byte TCP pipe — it copies whatever
arrives on 8080 straight to the dev server. So the whole question is whether
the sprite edge STRIPS that `Authorization` header before proxying inward. The
spike verified the edge *accepts* the header; it did not verify that the
header stops there.

If it does not stop there, a previewed dev server — which is agent-authored or
npm-supply-chain code — can read an org-wide credential out of its own request
headers. That is worth one direct check against a real sprite (curl through
the preview origin to a server that echoes its request headers) before this is
enabled anywhere, and it is cheap. Nothing in the application can fix it if the
answer is bad; the mitigation would be an edge change or a header-stripping hop.

## What is NOT ready — the smoke has no target yet

**Staging cannot run it as configured**, and this is the open item:

- `fly/fly.web.staging.toml` deliberately leaves `CODE_EXECUTION_ENABLED` and
  `SANDBOX_CONTAINMENT_VERIFIED` unset, with the reason written into the file:
  "no sandbox egress review has been done for a staging network path". No
  sandbox means no dev server means nothing to preview.
- There is **no staging realtime app**. Detection *is* the realtime tier's
  `ports/watch` channel, and the HMR half of the proxy is its upgrade handler.
  Without it the preview never appears.
- There is **no staging proxy**, so whether staging fronts through
  `pagespace-proxy` or gets its own is an open decision, and it determines
  where the wildcard record points.

Three decisions, then the smoke has somewhere to run. Until it passes,
production stays dark: nothing in this document should be applied to
`pagespace-web` before a real browser has loaded a real dev server somewhere.
