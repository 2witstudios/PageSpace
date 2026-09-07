# Dev-server preview: turning it on

The dev-server preview ships **dark**. Every layer fails closed on a missing
variable, so a half-configured deployment shows nothing rather than something
wrong. This is the list of what has to be true, in order.

Preview apex: **`pagespace.io`** — registered, on our own DNS, and chosen
because it shares no registrable domain with `pagespace.ai`. A dev server's
own JavaScript running on `preview.pagespace.ai` could set `Domain=.pagespace.ai` cookies and toss
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

Verified with a real Caddy binary, not by reading: `caddy validate` passes,
and `caddy adapt` resolves the matcher to `*.preview.pagespace.io` when the
apex is set and to the unmatchable `*.preview.` when it is not. Both preview
routes land ahead of every host-less catch-all, and every block that sets
`X-Frame-Options: DENY` is host-matched to `pagespace.ai`, so a preview
response cannot pick one up.

One marginal collision to know about: the `/api/cron/*`, `/api/memory/cron`
and `/api/pulse/cron` 403 block is host-less, so a previewed dev server
serving one of those exact paths gets a 403 from the edge rather than its own
response.

Merge that PR and deploy `pagespace-proxy`, `pagespace-web` and
`pagespace-realtime` — with `--config`, or the `[env]` values do not land.

## 2. Environment

Set the same apex on every app that participates. There is no default
anywhere: an app that misses the variable keeps the feature dark, which is the
failure mode you want.

**Not `fly secrets set`.** `fly.toml [env]` OVERRIDES a secret of the same
name, so a value set both places is silently shadowed — the same trap the
sandbox gate flags carry a warning about in `fly.web.toml`. Neither of these
is a secret. They live in `[env]`, and `DEV_PREVIEW_APEX` is already there for
all three apps as of `PageSpace-Deploy` #27:

```toml
# fly/fly.proxy.toml, fly/fly.web.toml, fly/fly.realtime.toml
[env]
  DEV_PREVIEW_APEX = "pagespace.io"
  # DEV_PREVIEW_ENABLED = "true"   # web + realtime only; uncomment to go live
```

`[env]` changes only take effect on a **`--config` deploy** (`deploy-fly.sh`);
an image-only CI deploy preserves the running config, so a deploy that "went
green" is not evidence the variable landed. Check the running process:

```
fly ssh console -a pagespace-proxy -C 'printenv DEV_PREVIEW_APEX'
```

The apex alone is inert — `isDevPreviewConfigured()` requires the flag too —
so shipping the apex is a no-op for users and can go out well ahead of the
flag.

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

## 6. Before you turn it on: the sprite-edge token question

The proxy authenticates to the sprite edge with the **org-scoped** Sprites
bearer token — `preview-forward.ts` sets `authorization: Bearer <token>`
*after* the forwardable-header allowlist, so it deliberately survives the
filter that strips the client's own credentials
(`preview-proxy-policy.ts`, where `authorization` is absent from
`FORWARDABLE_REQUEST_HEADERS`). The WebSocket half does the same
(`preview-ws-tunnel.ts`). The in-sprite relay on 8080 is a **raw TCP pipe**
(`preview-relay.ts` — `client.pipe(upstream)` over `net`, no HTTP parsing at
all), so nothing on our side removes that header on the way in.

The whole question is therefore whether the **sprite edge** strips it before
forwarding inward. The spike verified the edge *accepts* the header; it never
verified the header stops there. If it does not, a previewed dev server —
agent-authored or npm-supply-chain code — can read an org-wide credential out
of its own request headers.

**The check:** run a server on 5173 in a real sprite that echoes its request
headers, reach it through the preview origin, and read what arrived. Minutes,
one sprite, delete it after. Do not accept "the page rendered" as an answer —
read the headers the dev server actually received.

**If it leaks:** unset `DEV_PREVIEW_ENABLED` immediately and rotate
`SPRITES_API_TOKEN`. The fix is an edge change or a header-stripping hop;
nothing in the application can repair it.

## 7. Where the smoke runs

**Production** — and that is not a compromise, it is the only place with
sandboxes. `CODE_EXECUTION_ENABLED` and `SANDBOX_CONTAINMENT_VERIFIED` are
both `"true"` on `fly.web.toml` and `fly.realtime.toml`. An earlier draft of
this document said staging had to host it; staging deliberately leaves those
flags unset (`fly.web.staging.toml`: "no sandbox egress review has been done
for a staging network path"), has no realtime app and no proxy, so it cannot
run this at all. Standing one up is real work and buys nothing the flag does
not already buy: unsetting `DEV_PREVIEW_ENABLED` takes the whole feature back
out on the next request.

**Do the first pass by hand.** `21-dev-preview.spec.ts` needs `E2E_SANDBOX=1`
*and* `DATABASE_URL`, because it calls `seedUser` — pointing it at production
writes a test user into the production database. Run the spec only against a
database you are willing to seed. The manual walkthrough covers the same
ground:

1. Open an agent session; start a real Vite dev server on 5173.
2. The affordance appears **on its own** naming `:5173` — no page action.
3. Preview → the app renders through `https://ws-<id>.preview.pagespace.io/`.
4. Edit a source file → the frame hot-updates **without a reload**.
5. Confirm the `allowedHosts` failure first, then that `server.allowedHosts`
   fixes it — so we know what a user hits, not just that it can work.
6. Bind something on **9000** → detected but *not* shared; approve in the
   pane; it serves.
7. Sign out in another tab → the preview stops answering on the **next**
   request, not ten minutes later.

## Known gaps, open on purpose

- **A deferred reconcile is never retried.** If the holder's advisory lock is
  unavailable when a `port_opened` frame arrives, the detector logs
  `deferred` and drops it. The cron sweep cannot recover it — its WHERE clause
  requires `stoppedByUserAt IS NOT NULL AND relayServiceName IS NOT NULL`, so
  a preview that never started is invisible to it — and a dev server that
  binds once emits no further frames. The user sees no preview and no error.
- **The advisory lock has no time bound.** `services.get/list/remove` and
  `getSprite` carry no timeout, and `services.create/start/stop` bound only
  the log-stream drain, not the HTTP call. The advisory pool is `max: 10` and
  shared with every other advisory-lock consumer, so hung Sprites calls
  degrade more than the preview.

Both are tracked as follow-up work. Neither is a security issue, and the
kill switch covers both.
