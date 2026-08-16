# Fly verification spike — Published Apps (Phase 0)

**Date**: 2026-08-15 (executed 2026-08-16 02:19–02:26 UTC)
**Epic**: Published Apps (Fly Machines) — PageSpace page `thjql2b2eu2oaty6jouqbmb2`, Phase 0 requirement
"Given unverified Fly behaviors, should a spike confirm: deploy_token endpoint, fly-replay to a zero-IP app,
replay auto-start error semantics…"
**Org**: `personal` · **Region**: `iad` · **flyctl**: v0.4.75 · **Fly proxy build**: `Fly/40bd1ce81 (2026-08-13)`

All tokens in this document are redacted as `<REDACTED>`. Every resource created was destroyed (see
[Teardown](#teardown)).

## Summary of verdicts

| # | Question | Verdict |
|---|---|---|
| 1 | `POST /v1/apps/{app}/deploy_token` exists, shape, scope | **CONFIRMED** — exists, returns `{"token": "<macaroon pair>"}`, app-scoped: full machine CRUD on its own app, `403 unauthorized` on every other app and on org-level calls |
| 2a | fly-replay reaches a target app with **zero IP allocations** | **CONFIRMED** — but only when router and target share a 6PN network |
| 2a′ | fly-replay across **per-app `network`** isolation | **REFUTED — architecture-breaking.** `cross-network replays are not allowed` (502). Conflicts with locked decision D2 |
| 2b | Proxy **auto-starts** a stopped target on a routed request | **CONFIRMED** — 3/3 cycles, `events` records `source: "proxy"` |
| 2c | Wake latency | **MEASURED** — 1.39 / 1.55 / 1.44 s end-to-end vs 0.08–0.16 s warm ⇒ ~1.25–1.45 s wake cost |
| 2d | Client-visible error when the target has no machines | **CONFIRMED (worse than assumed)** — `502`, `content-length: 0`, empty body, **~7.5–7.9 s stall**. `fly-replay: …;timeout=1500` collapses the stall to **~0.08 s** |
| 3 | Machine `events` retention | **PARTIAL / REFUTED-as-usable** — the endpoint returns **only the most recent 20 events**, not a time window. 20 events = **5 stop/start cycles**. Mirroring at write time is mandatory, not optional |

---

## Question 1 — `POST /v1/apps/{app}/deploy_token`

### Request

```
POST https://api.machines.dev/v1/apps/pgs-spike-target/deploy_token
Authorization: Bearer <REDACTED org token, minted with `fly tokens create org --org personal --expiry 2h`>
Content-Type: application/json

{"expiry":"48h"}
```

### Response

```
HTTP/2 200
content-type: application/json; charset=utf-8
content-length: 716
server: Fly/40bd1ce81 (2026-08-13)
fly-request-id: 01M045VN0AF0QTQ5Z8FSV7XP62-dfw

{"token":"FlyV1 fm2_lJPECAAAAAAAFC3sxBD2SeJICp<REDACTED…>,fm2_lJPETpvgSO0IQKhp0HZ<REDACTED…>"}
```

Shape notes:

- Single key `token`. Value is a **comma-separated macaroon pair** (`FlyV1 fm2_…,fm2_…`) — the standard Fly
  token + discharge format, usable verbatim as `Authorization: Bearer <value>` and as `docker login -u x -p`.
- No `id`, `expires_at`, or metadata in the response. **If you need to revoke or audit a specific deploy
  token later, you must record it yourself at mint time** — the response gives you no handle.
- Body is required: omitting it returns `HTTP 400 {"error":"EOF"}`.
- Decoded caveat text visibly contains `builder` — consistent with this being the same token type flyctl
  mints for `registry.fly.io` pushes.

### Scope probes (all with the minted deploy token)

| Probe | Result |
|---|---|
| `GET /v1/apps/pgs-spike-target/machines` (own app) | `HTTP 200` `[]` |
| `POST /v1/apps/pgs-spike-target/machines` (own app, create) | `HTTP 200`, machine `80167df6527468` created |
| `POST /v1/apps/pgs-spike-target/machines/{id}/stop` | `HTTP 200` |
| `DELETE /v1/apps/pgs-spike-target/machines/{id}` | `HTTP 200` |
| `POST /v1/apps/pgs-spike-target/deploy_token` (self-renew) | `HTTP 200` — a deploy token can mint a new deploy token **for its own app** |
| `GET /v1/apps/pgs-spike-other/machines` (other app) | `HTTP 403` `{"error":"unauthorized"}` |
| `POST /v1/apps/pgs-spike-other/machines` (other app, create) | `HTTP 403` `{"error":"unauthorized"}` |
| `POST /v1/apps/pgs-spike-other/deploy_token` (escalation attempt) | `HTTP 403` `{"error":"unauthorized"}` |
| `GET /v1/apps?org_slug=personal` (org list) | `HTTP 403` `{"error":"unauthorized"}` |
| `POST /v1/apps` (create a new app) | `HTTP 403` `{"error":"unauthorized"}` |

**VERDICT 1: CONFIRMED.** The endpoint exists, is undocumented-but-live, and produces a token whose blast
radius is exactly one app: full machine lifecycle on that app, nothing outside it — including no app
creation and no org enumeration. It self-renews for its own app but cannot mint for another.

**Implication for the epic**: a per-published-app deploy token is a safe credential to hand to a build job
or to a per-app runtime component; a compromised one cannot enumerate the org or touch a sibling tenant's
app. Two caveats to design around: (1) no token id is returned, so `published_apps` must persist a mint
record if we ever want targeted revocation; (2) self-renewal means a leaked token can extend its own life
indefinitely — revocation has to happen at the app or org level, so treat app destruction as the kill
switch and keep expiries short.

---

## Question 2 — fly-replay to a zero-IP target

### Setup

Two pairs of apps were built, differing **only** in the `network` field at app creation:

| App | `network` at create | IPs | Machine |
|---|---|---|---|
| `pgs-spike-router` | `pgs-spike-router-net` (custom) | shared v4 `66.241.125.71` | nginx:alpine + replay config |
| `pgs-spike-target` | `pgs-spike-target-net` (custom) | **none** | nginx:alpine, `autostart: true`, `autostop: "stop"` |
| `pgs-spike-router2` | *(omitted → default)* | shared v4 `66.241.125.17` | nginx:alpine + replay config |
| `pgs-spike-target2` | *(omitted → default)* | **none** | nginx:alpine, `autostart: true`, `autostop: "stop"` |

Target machine config (created through the Machines API, no build):

```json
{
  "name": "spike-target-m1",
  "region": "iad",
  "config": {
    "image": "nginx:alpine",
    "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 256},
    "services": [{
      "protocol": "tcp", "internal_port": 80,
      "autostart": true, "autostop": "stop",
      "ports": [{"port": 80, "handlers": ["http"]},
                {"port": 443, "handlers": ["http", "tls"]}]
    }]
  }
}
```

Router: same image, plus a `files` entry writing `/etc/nginx/conf.d/default.conf` (base64 `raw_value`) —
i.e. **no image build was needed to stand up a replay router**; a public registry image plus a machine-config
file is enough.

```nginx
server {
  listen 80 default_server;
  location / {
    add_header fly-replay "app=pgs-spike-target2" always;
    return 200 "router2: replay-fallthrough\n";
  }
}
```

Zero-IP precondition, verified on both targets:

```
$ fly ips list -a pgs-spike-target2
 VERSION │ IP │ TYPE │ REGION │ CREATED AT
(empty)
```

### (a) Does the request reach a target with zero IPs?

```
$ curl -i http://pgs-spike-router2.fly.dev/
HTTP/1.1 200 OK
server: Fly/40bd1ce81 (2026-08-13)
content-type: text/html
content-length: 896
via: 1.1 fly.io, 1.1 fly.io
fly-request-id: 01M045YX90P9SRSMXW56K3J0GR-dfw

<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
```

The body is the **target's** nginx default page, not the router's `router2: replay-fallthrough` string, and
`via` shows two fly.io hops. The target has no IP allocation of any kind.

**VERDICT 2a: CONFIRMED** — fly-replay `app=` reaches a target app with zero IP allocations, provided the
router and target are on the **same 6PN network**.

### (a′) The blocker: per-app `network` isolation kills replay

The first pair (`pgs-spike-router` → `pgs-spike-target`), each created with its own `network`, failed:

```
$ curl -i http://pgs-spike-router.fly.dev/
HTTP/1.1 502 Bad Gateway
server: Fly/40bd1ce81 (2026-08-13)
content-length: 0
fly-request-id: 01M045XPK5JS7QW6WKKCM26T22-dfw
```

Router-side proxy log, verbatim:

```
proxy[784567db1049d8] iad [error] request.url="/"
error.message="app 'pgs-spike-router' used 'fly-replay' response header to target app 'pgs-spike-target',
but cross-network replays are not allowed"
```

Isolated as a single variable — `pgs-spike-router2` (default network) replaying to `pgs-spike-target`
(custom network) fails identically:

```
$ curl -i http://pgs-spike-router2.fly.dev/crossnet
HTTP/1.1 502 Bad Gateway
```
```
error.message="app 'pgs-spike-router2' used 'fly-replay' response header to target app 'pgs-spike-target',
but cross-network replays are not allowed"
```

…while the same router replaying to `pgs-spike-target2` (default network) returns 200. **Network membership
is the only difference.**

**VERDICT 2a′: REFUTED — and it invalidates a locked decision.** Decision **D2** in the epic says published
apps are "created with its own `network` (6PN isolation)". That is mutually exclusive with routing them via
fly-replay from a shared router app. Phase 3's entire routing design depends on replay working, so one of
the two has to change before Phase 1 ships:

1. **Drop per-app `network`** — all published apps share the org default network, and isolation comes from
   elsewhere (no service discovery hostnames per app, no listening on 6PN ports, egress rules). This is
   the path Fly's own fly-replay blueprints implicitly take.
2. **Put the router inside each app's network** — defeats the point of one router.
3. **Route without fly-replay** — the proxy would need a public IP per app (cost + the wake gate moves).

Note the security consequence of option 1: apps on a shared 6PN network can reach each other's private IPs
directly. That has to be closed at the guest level (the runtime image's egress policy) rather than assumed
from `network`. This should go back to Jono as a decision, not be resolved inside the build.

### (b) Auto-start of a stopped target

Target machine stopped via `POST /machines/{id}/stop`, waited to `state=stopped`, then one HTTP request to
the router. Three consecutive cycles, all returning `HTTP 200` with the target's body, and the machine
observed in `state: "started"` afterwards.

**VERDICT 2b: CONFIRMED** — the proxy auto-starts a stopped replay target. `services[].autostart: true` is
present on the target; no request was needed against the target's own (nonexistent) public address.

### (c) Wake latency

| Cycle | First request after stop | Warm follow-up |
|---|---|---|
| 1 | **1.386 s** (ttfb 1.386 s) | 0.149 s |
| 2 | **1.555 s** (ttfb 1.554 s) | 0.156 s |
| 3 | **1.444 s** (ttfb 1.443 s) | 0.083 s |

Measured with `curl -w '%{time_total} %{time_starttransfer}'` from a US client to `iad`, so the numbers
include client→edge RTT (~80–150 ms, visible in the warm rows).

**Wake cost ≈ 1.25–1.45 s** on top of a warm request, for a 256 MB shared-cpu-1x machine running
`nginx:alpine`. Consistent with the "rootfs assembles at create, not start" research fact — this is a
resume, not a build. A real user image with a slower entrypoint will add its own boot time on top; treat
~1.4 s as the **floor**, not the expected value.

### (d) Error semantics when the target cannot serve

Three distinct no-target conditions, all from the same router:

| Condition | Client sees | Time |
|---|---|---|
| App exists, its only machine **destroyed** (`pgs-spike-target2`) | `502`, `content-length: 0`, empty body | **7.86 s** |
| App exists, **never had a machine** (`pgs-spike-empty`) | `502`, `content-length: 0`, empty body | **7.73 / 7.57 / 7.59 s** |
| App **does not exist** (`pgs-spike-nonexistent-xyz`) | `502`, `content-length: 0`, empty body | **7.50 s** |

```
$ curl -i http://pgs-spike-router2.fly.dev/empty
HTTP/1.1 502 Bad Gateway
server: Fly/40bd1ce81 (2026-08-13)
via: 1.1 fly.io
fly-request-id: 01M0464F31MG0598DM4G6JSA4A-dfw
content-length: 0
date: Sun, 16 Aug 2026 02:24:18 GMT

[time_total=7.731975]
```

The **client body is empty in every case** — the distinguishing information exists only in the router app's
proxy log:

```
error.message="app pgs-spike-router2 tried to fly-replay to app pgs-spike-target2, but nothing from that app serves port tcp/80"
error.message="app pgs-spike-router2 tried to fly-replay to app pgs-spike-empty, but nothing from that app serves port tcp/80"
error.message="app 'pgs-spike-router2' used 'fly-replay' response header to target app 'pgs-spike-nonexistent-xyz', which we cannot find"
```

#### The `timeout=` field fixes the stall

The `fly-replay` header accepts a `timeout` field, and it changes failure latency by two orders of magnitude:

```nginx
location /empty   { add_header fly-replay "app=pgs-spike-empty" always; ... }
location /empty-t { add_header fly-replay "app=pgs-spike-empty;timeout=1500" always; ... }
```

```
/empty   try1 http=502 t=7.849539
/empty   try2 http=502 t=7.517016
/empty-t try1 http=502 t=0.080423
/empty-t try2 http=502 t=0.074088
```

**VERDICT 2d: CONFIRMED, with a design requirement.** A replay to an app with no serving machine yields a
bare `502` with an empty body after **~7.5–7.9 s** by default — an unacceptable failure page for a published
app. Setting `timeout=` on the replay header returns the 502 in **~80 ms** instead. Phase 3 must therefore:

- always emit `timeout=` on the replay header, and
- have the **router** render the user-facing error/parked page itself (detect the failure and serve HTML)
  rather than letting the bare 502 through — Fly gives the client nothing to render.

Note the interaction with metering: a broken/destroyed app costs a visitor 7.9 s of held connection per
request if `timeout=` is omitted, which is also a cheap amplification vector against the router.

---

## Question 3 — Machine events retention

### Request

```
GET https://api.machines.dev/v1/apps/pgs-spike-target2/machines/830371c7724638/events
Authorization: Bearer <REDACTED>
```

### Response sample (verbatim, first 4 of 15 elements)

```json
[
  {
    "id": "01M045ZJRCZ9SGQ0WC8SGKFS3Q",
    "type": "start",
    "status": "started",
    "request": {},
    "source": "flyd",
    "timestamp": 1786846890764
  },
  {
    "id": "01M045ZHKZ0C33XWFTGCK4MKYD",
    "type": "start",
    "status": "starting",
    "source": "proxy",
    "timestamp": 1786846889599
  },
  {
    "id": "01M045ZH1ZN2JFXYM4GK1S6C16",
    "type": "exit",
    "status": "stopped",
    "request": {
      "exit_event": {
        "requested_stop": true,
        "restarting": false,
        "guest_exit_code": 0,
        "guest_signal": -1,
        "guest_error": "",
        "exit_code": 0,
        "signal": -1,
        "error": "",
        "oom_killed": false,
        "exited_at": "2026-08-16T02:21:28.614Z"
      },
      "restart_count": 0
    },
    "source": "flyd",
    "timestamp": 1786846889023
  },
  {
    "id": "01M045ZG28KTY8DSQG4GJG01T9",
    "type": "stop",
    "status": "stopping",
    "request": { "reason": "" },
    "source": "user",
    "timestamp": 1786846888008
  }
]
```

### Observed baseline (after create + 3 proxy-wake cycles) — 15 events, newest first

```
1786846890764 start  started  flyd
1786846889599 start  starting proxy      <-- proxy auto-start (the wake)
1786846889023 exit   stopped  flyd
1786846888008 stop   stopping user       <-- our API stop
1786846887463 start  started  flyd
1786846886240 start  starting proxy
1786846885714 exit   stopped  flyd
1786846884838 stop   stopping user
1786846884307 start  started  flyd
1786846883177 start  starting proxy
1786846882840 exit   stopped  flyd
1786846882257 stop   stopping user
1786846861429 start  started  flyd
1786846858799 launch created  user
1786846858650 launch pending  flyd
```

### Retention probe

Eight further API-driven stop/start cycles were run (32 additional events), then the endpoint was re-read:

```
count: 20
oldest: 1786846920402 stop stopping
newest: 1786846995885 start started
Counter({('start','started','flyd'): 5, ('start','starting','user'): 5,
         ('exit','stopped','flyd'): 5, ('stop','stopping','user'): 5})
```

The `launch` events — created ~2 minutes earlier and previously present — are **gone**, and the list is
pinned at exactly 20 with a clean 5×4 shape.

**VERDICT 3: PARTIAL — the endpoint is bounded by count, not time, at 20 events.**

Consequences for the metering design (Phase 4):

- **20 events = 5 stop/start cycles.** A busy scale-to-zero app can blow through the entire window in
  minutes. The epic's plan to "mirror machine events to a local table at write time" is not a nice-to-have
  optimisation — it is the **only** way to get a complete record. A cron that polls `events` periodically
  will silently lose cycles.
- **`source` is the discriminator we need.** `source: "proxy"` on a `start/starting` event marks a
  **proxy-driven wake** (a request arrived); `source: "user"` marks **our own** API call. Since the wake
  gate implies the proxy will start machines we did not ask to start, awake-seconds cannot be derived from
  our own API calls alone — the `proxy` starts must be captured too. Note the retention probe's cycles show
  `('start','starting','user')` where the earlier HTTP-driven cycles show `proxy`, confirming the field
  distinguishes the two paths reliably.
- **Timestamps are epoch milliseconds** (`1786846890764`), while `exit_event.exited_at` is RFC3339. Both
  appear in the same payload; normalise at ingest.
- `exit_event` carries `oom_killed`, `guest_exit_code`, and `restart_count` — enough to distinguish a clean
  stop from a crash for the app dashboard, so mirror the whole `request` blob, not just type/status.
- **Not measured**: whether events also expire on a time bound below the 20-count bound (the probe ran
  inside ~2 minutes), and whether the cap is per-machine or shared. Both are moot given the count bound is
  already tighter than the metering need.

---

## What this spike changes in the epic

1. **D2 (per-app `network`) must be revisited before Phase 1.** It is incompatible with fly-replay routing.
   This is a founder decision, not an implementation detail — see options in [2a′](#a-the-blocker-per-app-network-isolation-kills-replay).
2. **Phase 3 must emit `timeout=` on every fly-replay header** and render its own error/parked page; the
   default failure is a 7.9 s empty 502.
3. **Phase 4 must mirror machine events synchronously**, and must treat `source: "proxy"` starts as billable
   wakes — the 20-event window cannot be polled after the fact.
4. **Deploy tokens are safe to use per-app** and need no org-token distribution to build jobs, but record the
   mint yourself (no token id is returned) and rely on app destruction as the revocation path.
5. **Wake budget: ~1.4 s floor** for a trivial image — worth stating in the product copy and in the router's
   loading behaviour.

### Not covered by this spike (still unverified)

- `state=` preshared-key round-trip and `fly-replay-src` header contents at the target.
- `fly-replay-cache` behaviour and whether it can bypass the balance gate.
- Max certificates per app at scale; org app-count quotas (needs a conversation with Fly).
- Behaviour of replay with request bodies near the 1 MB limit.

## Teardown

```
$ fly apps destroy pgs-spike-target  --yes   # Destroyed app pgs-spike-target
$ fly apps destroy pgs-spike-router  --yes   # Destroyed app pgs-spike-router
$ fly apps destroy pgs-spike-other   --yes   # Destroyed app pgs-spike-other
$ fly apps destroy pgs-spike-target2 --yes   # Destroyed app pgs-spike-target2
$ fly apps destroy pgs-spike-router2 --yes   # Destroyed app pgs-spike-router2
$ fly apps destroy pgs-spike-empty   --yes   # Destroyed app pgs-spike-empty

$ fly apps list | grep pgs-spike
(no output — exit 1)
```

Token minted for this spike (`pgs-spike-org`, org scope, 2 h expiry) revoked:

```
$ fly tokens revoke 60XMXnbzk4eybuLoxgj02GxemnCzkGLj8azy2lMCe
Revoked 60XMXnbzk4eybuLoxgj02GxemnCzkGLj8azy2lMCe
1 tokens revoked

$ curl -o /dev/null -w '%{http_code}' https://api.machines.dev/v1/apps?org_slug=personal -H "Authorization: Bearer <that token>"
401
```

The app-scoped deploy tokens minted in Question 1 were destroyed along with their apps (they are app-scoped
and do not appear in the org token list). No existing PageSpace app was read-modified, deployed, or touched.

**Spend**: 6 apps, 4 machines, all `shared-cpu-1x/256 MB` in `iad`, total machine uptime under ~8 minutes
across all machines, one shared IPv4 per router (free), no volumes, no builds, public registry images only.
Well under the $0.10 ceiling.
