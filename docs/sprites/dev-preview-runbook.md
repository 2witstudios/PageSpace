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

Neither value is a secret, so both live in `[env]`, where they are reviewable
and travel with the deploy. `DEV_PREVIEW_APEX` is already there for all three
apps as of `PageSpace-Deploy` #27:

```toml
# fly/fly.proxy.toml, fly/fly.web.toml, fly/fly.realtime.toml
[env]
  DEV_PREVIEW_APEX = "pagespace.io"
  # DEV_PREVIEW_ENABLED = "true"   # web + realtime only; uncomment to go live
```

**Precedence, because the tree gets this backwards.** `fly.web.toml` and
`fly.realtime.toml` both carry a comment claiming `[env]` overrides a
same-named secret. It is the other way round —
[Fly's configuration reference](https://fly.io/docs/reference/configuration/):
*"Secrets take precedence over env variables with the same name."* Nobody has
noticed because `CODE_EXECUTION_ENABLED` and `SANDBOX_CONTAINMENT_VERIFIED`
are set BOTH ways on `pagespace-web` with the same value, so the two readings
agree by accident. So: do not also `fly secrets set` either preview variable —
a secret would win and silently mask the value in the config the reviews see.

`[env]` changes only take effect on a **`--config` deploy** (`deploy-fly.sh`);
an image-only CI deploy preserves the running config, so a deploy that "went
green" is not evidence the variable landed. Check the running processes —
**all three**, because a partial rollout passes any single-app check while the
origin the browser is sent to is not the origin a server will accept:

```
for app in pagespace-proxy pagespace-web pagespace-realtime; do
  echo "== $app"
  fly ssh console -a "$app" -C 'printenv DEV_PREVIEW_APEX DEV_PREVIEW_ENABLED' || true
done
```

`pagespace-proxy` should report the apex and no flag; web and realtime should
report both once you are live.

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

## 6. The sprite-edge token question — ANSWERED, it does not leak

The proxy authenticates to the sprite edge with the **org-scoped** Sprites
bearer token: `preview-forward.ts` sets `authorization: Bearer <token>`
*after* the forwardable-header allowlist, so it deliberately survives the
filter that strips the client's own credentials (`preview-proxy-policy.ts`,
where `authorization` is absent from `FORWARDABLE_REQUEST_HEADERS`). The
in-sprite relay on 8080 is a **raw TCP pipe** (`preview-relay.ts` —
`client.pipe(upstream)` over `net`, no HTTP parsing), so nothing on our side
removes it on the way in. The open question was whether the EDGE strips it
before forwarding inward — if not, a previewed dev server (agent-authored or
npm-supply-chain code) could read an org-wide credential from its own headers.

**Checked against a real sprite on 2026-09-07: the edge strips it.**

Method: create a sprite, `updateURLSettings({ auth: 'sprite' })` — the only
mode the preview path will proxy to (`preview-access.ts:263`) and the mode
where the edge validates the bearer — run a server on 8080 that appends every
request header it receives to a file, then fetch the sprite URL with the
bearer plus a canary header, and read the file back out of the sprite.

```
Host: <sprite>.sprites.app
User-Agent: node
Sprite-Client-Ip: …
Via: 1.1 fly.io
X-Canary-Header: canary-value        <-- passthrough works
X-Forwarded-For / -Port / -Proto / -Ssl
X-Request-Start: …
```

No `Authorization`, and the token value appears nowhere. The canary is the
control that matters: headers plainly DO reach the dev server, so the absence
of `Authorization` is the edge removing it, not the test failing to look.

**Two limits on that result, both deliberate:**

- It covers the **HTTP** half. The WebSocket half (`preview-ws-tunnel.ts`)
  sends the same bearer on the upgrade request, and the upgrade takes a
  different path through the edge. That has NOT been checked — worth doing
  before HMR is relied on, by the same method against an upgrade request.
- It used a freshly minted org token rather than the production
  `SPRITES_API_TOKEN`. The edge's behaviour is a property of the edge and the
  auth mode, not of which token is presented, so this is the same question —
  but it is not literally the production credential.

The script is disposable; re-run it with the recipe above if the edge changes.

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

## Turning it off

The kill switch is `DEV_PREVIEW_ENABLED`, and it is GLOBAL — there is no
per-drive rollout, so it exposes the feature to every user at once and takes
it back from every user at once. Every entry point fails closed on the next
request: the proxy 404s, the grant mint 404s, the WebSocket upgrade is
refused, detection stops opening watch channels, and the cron sweep no-ops.

The fast path is a **secret**, not an `[env]` edit, because of the precedence
rule in §2 — a secret beats the config value and takes effect on the restart
it triggers, with no `--config` deploy to wait for:

```
fly secrets set DEV_PREVIEW_ENABLED=false -a pagespace-web
fly secrets set DEV_PREVIEW_ENABLED=false -a pagespace-realtime

# Confirm it took in the RUNNING processes, not just in the API.
fly ssh console -a pagespace-web      -C 'printenv DEV_PREVIEW_ENABLED'
fly ssh console -a pagespace-realtime -C 'printenv DEV_PREVIEW_ENABLED'
```

Only the literal string `'true'` enables the feature, so `false` — or any
other value — is off.

Afterwards, comment the `[env]` flag back out and `fly secrets unset
DEV_PREVIEW_ENABLED` on both apps, so the config and the running state agree
again rather than drifting apart with a secret quietly overriding the file.

**If a credential is ever implicated** — §6 says the edge strips the org token
today, but if that changes, or the WebSocket half turns out to differ — the
order matters: switch the feature off and CONFIRM it before rotating
`SPRITES_API_TOKEN`. Rotating first while forwarding is still up simply hands
the previewed dev server the new credential.

## Runtime behaviour worth knowing

- **A refused reconcile is retried, three times across ~21s.** If the holder's
  advisory lock is unavailable when a `port_opened` frame arrives, the
  detector no longer drops it — dropping it meant a running dev server got no
  preview and no error, because a quiet server emits no further frames, the
  backstop sweep only sees rows that are switched OFF and still name a relay,
  and a healthy watcher is never recycled. The retry is cancelled when the
  connection drops (the next `port_list` reconciles instead), when a newer
  frame reconciles ahead of it, and when the detected port itself closes. Past
  the budget it gives up with a `warn` rather than retrying forever.
- **Control-plane READS are bounded at 15s.** `services.list` and
  `services.get` stop waiting rather than pinning an advisory-lock connection
  from a pool of ten that every lock consumer shares.
- **Control-plane MUTATIONS are deliberately NOT bounded.** `services.create`,
  `start`, `stop` and `remove` still wait indefinitely. Abandoning the wait
  would release the lock while the mutation is in flight, letting the next
  holder plan against a sprite about to change under it — the exact
  interleaving the lock exists to prevent — and the Sprites SDK exposes no
  `AbortSignal`, so there is no way to end the call rather than the wait. A
  hung mutation still holds its connection. That is the remaining gap.
- **`getSprite` is likewise unbounded**, for the same reason: it is reached
  through the same SDK surface.

The kill switch covers all of it: unset the flag and every entry point fails
closed on the next request.
