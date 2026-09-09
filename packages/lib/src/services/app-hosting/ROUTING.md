# Published-app serving edge

How a request for `<subdomain>.<apex>` becomes a response, what has to be
configured for it to work, and the two out-of-band actions (a PSL submission and
a Fly network choice) that this repo cannot perform for itself.

Everything here ships behind `APP_HOSTING_ENABLED`. With the flag off the router
endpoint is inert: it answers `hosting_disabled` before reading the database.

## The request path

```
client → pagespace-proxy (Caddy, terminates TLS for *.<apex>)
       → POST/GET pagespace-web /api/app-hosting/router
            with x-pagespace-app-host: <original hostname>
                 x-pagespace-app-router-key: <APP_ROUTER_PROXY_SECRET>
       → resolveAppRoute()  ── published_apps row + payer balance
       ├─ replay   → 204 + `fly-replay: app=…;state=…;timeout=1500`
       │             Fly replays the ORIGINAL request to the target app,
       │             auto-starting its machine if stopped.
       └─ refusal  → the parked / unavailable / not-found page, served here,
                     and NO machine is started.
```

Two consequences of this shape are easy to get wrong later:

- **A replayed response never comes back through us.** Fly hands the request to
  the target app and returns its response straight to the client, so no Caddy
  header stanza and nothing in the router route applies to a published app's own
  output. A published app owns its security headers.
- **The rewritten path is not what gets replayed.** The proxy rewrites to
  `/api/app-hosting/router`, but `fly-replay` replays the request the client
  actually made.

## The route lives behind the web app's middleware

`apps/web/src/middleware.ts` runs in front of every `/api` path, and the router
endpoint has to be carved out of it explicitly — in the right *place*, not just
at all. It returns alongside `/api/public/forms`, above origin validation and
above the Bearer-API `OPTIONS` short-circuit. There are **three ways to get it
wrong** — never carved out, carved out but without skipping the CSP, or carved
out too late — and they produce **four distinct symptoms**, because the last one
breaks in two independent places. None of the four fails a handler test: handler
tests invoke the route directly, and all four of these live above it.

| missing/misplaced | symptom |
| --- | --- |
| not on the public list | 401 before `route.ts` runs — **no published app is reachable** |
| middleware CSP not skipped | `default-src 'none'` falls `style-src` back to `'none'`; the parked page renders unstyled |
| below origin validation | a published app's own fetch carries its own origin, which is never in our allowlist → 403 on every non-GET |
| below the `OPTIONS` short-circuit | a published app's CORS preflight is answered with *our* policy instead of being replayed to the app |

`middleware.test.ts` guards all four symptoms; each is mutation-checked. If you add another
`/api/app-hosting/*` route, note the exemption is an **exact path match** and does
not extend to siblings — an authenticated route there should not inherit it.

## Why every request pays a router hop

The metered tier sets **no `fly-replay-cache`**. The cache exists to skip the
router hop on subsequent requests — and the router hop *is* the balance gate, so
a cached replay would keep a machine awake and billing for a payer we would
refuse today.

Every asset of a published page therefore costs one hop plus, for a servable
metered app, three single-row indexed reads: the `published_apps` lookup, the
payer's tier, and the payer's funded balance. No aggregates —
`hasSpendableBalance` deliberately avoids `getCreditBalance`, which would add a
`SUM` over active `credit_holds` that the gate then discards. A refusal costs
fewer: an app refused on status alone never reaches the ledger.

That is the price of the enforcement property, and it is bounded by the fact that
only the decision is ours; the bytes are not.

The flat-rate **dedicated** tier is the only legitimate cache user, because it
has no balance gate to bypass. See `replayCachePolicyFor`.

## Balance-check-before-wake

`decideAppRoute` refuses to replay when the payer is out of credits, so the
machine is never started and never bills. Enforcement is "don't wake", not
clawback — there is no credit to claw back from an account that has none.

Order is load-bearing: the persisted `parked` status is checked **before** the
live balance read, because un-parking (and restarting) belongs to the metering
cron, not to a router that never writes. **That cron lands separately** — the
awake-seconds metering work in PR #2493, not this branch — so nothing here
un-parks anything yet; both halves ship dark behind `APP_HOSTING_ENABLED`. Conversely a `running` row whose payer
has run out is refused anyway: the row lags by up to one cron tick, the balance
does not.

An unrecognized status resolves to `unavailable`, never to `replay` — a status
added later must not start billing machines through a router that has never
heard of it.

## Uploads: the 1MB replay ceiling

Fly will not replay a request whose body exceeds 1MB. The router answers such a
request with a `413` naming the limit rather than letting it surface as an opaque
502 from the platform.

**Upload paths must go direct to Tigris via presigned URLs** and never traverse
the replay edge. No upload plumbing is built here; `MAX_REPLAYABLE_BODY_BYTES`,
`exceedsReplayableBody` and `exceedsStreamedBody` exist so the constraint is
enforced and legible at the edge.

The limit is checked two ways, because there are two ways to arrive:

| Request declares | Checked by | Cost |
| --- | --- | --- |
| `Content-Length` | `exceedsReplayableBody` | a header read |
| no `Content-Length` | `exceedsStreamedBody` | the body, measured, bounded at the limit |

The second is not redundant. A request that sends no `Content-Length` gives the
header check nothing to read, so it answers false and the request would reach
`fly-replay` — where Fly, unable to replay a body over the limit, fails it at the
platform and the client sees an opaque 502 instead of the 413. This is NOT only
HTTP/1.1 `Transfer-Encoding: chunked`: HTTP/2 forbids that header entirely and
carries request content in DATA frames with no length at all, so on a modern edge
the lengthless case is the norm rather than the exception. It is the default
shape of a streaming upload too, so the header check alone is bypassed by
accident as easily as on purpose. The measured read is bounded: it stops and
cancels at the first byte past the limit, and it only ever runs for a request
that gave us no length to read, so a request that declares its size still pays
nothing.

The edge proxy carries the same cap as defence in depth —
`request_body { max_size 1MiB }` in the `@published_apps` block of
`fly/Caddyfile.fly` in **PageSpace-Deploy**. That is not redundant with the check
here: it stops an oversized body crossing the internet into the flycast hop and
being streamed into this route only to be refused. The route keeps its own check
because it is the layer that decides whether to emit `fly-replay` at all, and
because a direct-to-web deployment has no proxy in front of it.

> **Write it `1MiB`, never `1MB`.** Caddy parses `MB` as 1,000,000 and `MiB` as
> 1,048,576, and `MAX_REPLAYABLE_BODY_BYTES` is 1,048,576. Written as `MB` the
> two layers would disagree about every body between those two figures: the proxy
> would refuse it while the router's own 413 page names a limit that allows it —
> a refusal the user cannot reconcile with the message explaining it.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `APP_HOSTING_ENABLED` | to serve at all | Kill switch. Exactly `"true"` enables. |
| `PUBLISHED_APPS_APEX` | **yes, once enabled** | Apex apps serve from. Normalized (`*.`/trailing dot/case). `validateEnv` refuses to boot with `APP_HOSTING_ENABLED=true` and no explicit value — see the PSL note below. `PUBLISHED_APPS_APEX_DEFAULT` remains the fallback only while hosting is dark, so `resolvePublishedAppsApex` never returns `''`. |
| `APP_ROUTER_FLY_APP_NAME` | no | Fly app that terminates the apex and holds custom-domain certs. Falls back to `FLY_PROXY_APP_NAME`, then `pagespace-proxy`. |
| `PUBLISHED_APPS_NETWORK` | yes, in practice | The shared 6PN network. See the invariant below. |
| `APP_REPLAY_SECRET` | to emit replays | ≥32 chars. Server-held secret the per-app `state` key is derived from. Unset ⇒ the router refuses to replay. |
| `APP_ROUTER_PROXY_SECRET` | to answer at all | ≥32 chars. Shared secret the proxy presents. Unset — **or shorter than the floor** — ⇒ the endpoint refuses **everything**. |

Both secrets fail **closed**. An unset `APP_ROUTER_PROXY_SECRET` is read as
"refuse everything", never as "skip the check" — the route is mounted on the web
app, which also answers at `pagespace.ai/api/...`, so without the check any
internet caller could hand us a hostname and collect a `fly-replay` header,
turning our own web app into a general-purpose replay emitter for the Fly org and
letting anyone wake (and bill) any published app they can name.

## Invariant: one Fly network

**The router app and every published app must live on the same Fly 6PN network.**
fly-replay cannot cross networks — the proxy answers
`502 cross-network replays are not allowed` — and **a Fly app's network is fixed
at create time**, so this cannot be repaired by redeploying.

Satisfy it one of two ways, both pure configuration:

1. create published apps on the existing router's network
   (`PUBLISHED_APPS_NETWORK=<router's network>`), or
2. point `APP_ROUTER_FLY_APP_NAME` at a router app that was itself created on
   `PUBLISHED_APPS_NETWORK`.

Nothing in this repo can verify which holds — the network an app was created on
is a Fly-side fact. `describeRouterNetworkInvariant()` renders the pair that has
to agree so a 502 is one log line from its cause.

## Custom domains

Custom hostnames attach to the **router app**, never to an individual published
app: the router is what Fly TLS-terminates, and a replay target has no public IP
at all. Certificates go through the Machines API certificates resource
(`/v1/apps/{app}/certificates`) in `services/fly/flaps-client.ts` — not the
legacy GraphQL mutations — because those responses carry `dns_requirements` and
`validation`, which name the exact records a stuck hostname is waiting on.

`_fly-ownership` TXT pre-validation (`validators/fly-ownership.ts`) exists
because, through a certificate's status alone, "Fly has not issued yet" and "the
customer was never told to publish a record" look identical and need opposite
responses.

A custom hostname reaching the router today answers `not_found` with reason
`custom_host`: `custom_domains` carries a `driveId` and resolves to a drive's
static published site, with no column naming a `published_apps` row. Those hosts
are served by the proxy's own custom-domain block and do not reach this route.
Binding a custom domain to a published app needs that pointer first.

## PSL: an out-of-band action, required before GA

Published apps serve from a **different apex** than `*.pagespace.site`, where
static canvas sites live. This is a security requirement, not tidiness.

`pagespace.site` is **not on the Public Suffix List**, so a document served from
`a.pagespace.site` can set a `domain=.pagespace.site` cookie that every other
published site then sends. Static canvas pages already carry that risk. A
published app is strictly worse: it runs arbitrary customer-authored **server**
code on its own origin, so it can set, read and act on those cookies without a
user ever visiting the victim site.

`PUBLISHED_APPS_APEX_DEFAULT` is the wiring for that decision. **Submitting the
apex to the PSL is not performed by this repo.** Before GA:

- [ ] Register the apex and point its wildcard at the router app.
- [ ] Submit it to the PSL as a private-section entry
      (<https://github.com/publicsuffix/list> — PR against `public_suffix_list.dat`,
      with the `_psl` DNS TXT validation record in place).
- [ ] Wait for the entry to ship in browser releases. **Listing is not
      retroactive** — until a browser's bundled copy contains it, the cookie
      boundary does not exist for that browser, so treat the submission date as
      the start of a months-long tail rather than the fix.
- [ ] Only then serve customer-authored server code from the apex to the public.

Until that lands, published apps must not be exposed to untrusted end users on a
shared apex. `APP_HOSTING_ENABLED` is what holds that line.

Because the checklist above is the only thing that can satisfy the PSL
requirement — no code can verify a browser's bundled list — the boot gate does
the one thing code *can* do: `validateEnv` refuses to start with
`APP_HOSTING_ENABLED=true` and no explicit `PUBLISHED_APPS_APEX`. That converts
"the apex is whatever the default is" into a value somebody typed, and therefore
owns. It does **not** verify PSL registration, and it is not a substitute for
working the list above.

## Per-app log streaming (runbook)

The app pane's live log viewer (`apps/realtime/src/app-logs/`) subscribes to
Fly's **org-wide firehose**, a fixed NATS endpoint on the org's private 6PN
network at `nats://[fdaa::3]:4223` (`app-logs-env.ts`) — not a per-app or
per-deployment server. Reaching it requires the connecting process to be
attached to the org's 6PN network; a Fly Machine is, a host outside Fly's
network is not, so `apps/realtime` must run on a Fly Machine in this org (or
behind a WireGuard peer to it) for logs to stream at all — this is a deploy
topology requirement, not a code path this repo can satisfy on its own.

Required secret: **`FLY_LOGS_NATS_TOKEN`** — a **read-only** NATS credential
for the firehose, provisioned as a Fly secret only (never a default, never
committed). Auth is the org slug (`resolvePublishedAppsOrgSlug` /
`FLY_MACHINES_ORG_SLUG`, the same org every published app lives in) as the
NATS username with this token as the password. Unset token = firehose not
configured = log streaming fails closed (no subscription opens; the pane shows
"logs unavailable" rather than the realtime process crashing).

The subject subscribed for one app (`logs.<flyAppName>.*.*`) is always built
server-side from the `published_apps` row the requesting user is
authorized to see — never from the client's copy of `flyAppName` — see
`app-log-handler.ts`'s `resolveAuthorizedFlyAppName`.
