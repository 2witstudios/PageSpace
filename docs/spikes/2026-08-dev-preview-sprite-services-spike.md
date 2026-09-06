# Spike: Sprites Services surface against a live Sprite (dev-server preview)

> **Date:** 2026-08-29/30 · **SDK:** `@fly/sprites@0.0.1-rc37` · **API:** `https://api.sprites.dev`
> **Why:** the dev-preview workstream (same-origin authenticated proxy to a dev server in a
> sandbox) rests on the SDK's Services surface (`createService`/`httpPort`/`SpriteInfo.url`/
> `urlSettings`), which had **never been verified against a live Sprite** — the old design doc
> (`docs/sprites/services-adoption-design.md`, OBSOLETE) said so itself in §7.
> **Method:** four throwaway Sprites driven end-to-end with a real org-minted token
> (`flyctl tokens create org` → `SpritesClient.createToken`), every one deleted in a `finally`
> and the deletion verified (`getSprite` → `sprite not found`). Every claim below is marked
> **verified** (observed on the wire) or **assumed** (docs/types only, not observed).

## TL;DR — what changed under the design doc

1. **The Services CRUD surface works exactly as the SDK types say.** `createService` (PUT,
   auto-starts, NDJSON log stream), `listServices`, `getService`, `startService`,
   `stopService`, `deleteService`, `signalService` — all real, all verified. **Part B (the
   typed seam) is buildable.**
2. **`httpPort` is accepted, stored, and DOES NOTHING to URL routing.** The sprite URL is a
   proxy to **port 8080, always**. A service bound to `httpPort: 8000` is unreachable via the
   URL (the request *hangs* — no 502); any plain process listening on 8080 — service or not —
   is served. Start-on-request never fired. The docs' "requests route to the service's port"
   and "the proxy starts it first" are **not the shipped behavior**.
3. **No one-http-port-per-Sprite scarcity.** A second service with its own `httpPort` was
   accepted without a 409. The design doc's P1 ("visibility is a property of the single
   HTTP-port slot") loses its enforcement mechanism — but also its urgency, since `httpPort`
   doesn't route anything. The real slot is **port 8080 itself**.
4. **URL auth (`auth: 'sprite'`) is real and org-token-friendly**: `Authorization: Bearer
   <sprites-token>` → 200 in ~56ms. No/invalid token → **302 to an SSO flow**
   (`https://sprites.dev/auth/sprite?return_url=…`), not a 401. `auth: 'public'` works and is
   flipped live by `updateURLSettings`. The zero-trust architecture (our proxy adds the org
   token; the URL stays `auth: 'sprite'`) is **confirmed viable** — with the 8080 caveat.
5. **`port_opened` frames are real but TTY-only**; `port_closed` was **never observed**.
   `stopService` leaves the service in `status: 'failed'` (`"exited with code 143"`), not
   `'stopped'`.

---

## 1. Setup (verified)

- Token recipe: `flyctl tokens create org -o personal -x 2h`, strip the leading `FlyV1` (plus
  its trailing space) prefix,
  `SpritesClient.createToken(macaroon, 'personal')` → a `personal…`-prefixed Sprites token
  (114 chars). The 2h expiry is real — a later run failed `APIError: unauthorized` until
  re-minted.
- Sprite image: `python3`, `node`, `bun` all present under `/.sprite/bin`; no `busybox`/`nc`.
  Kernel `6.12.105-fly` x86_64.
- `createSprite` returns `status: 'cold'`, an `id` (`sprite-<uuid>`), a `url`
  (`https://<name>-<org>.sprites.app`) and `urlSettings` **immediately** — no service needed
  for the URL to exist.

## 2. `SpriteInfo.url` + `urlSettings` (verified)

- Shape: `url: "https://ps-spike-preview-mtf27zhe-bskrl.sprites.app"`,
  `urlSettings: { auth: 'sprite', private_access: 'admins' }`. Note **`private_access` is not
  in the SDK's `URLSettings` type** (`{ auth?: string }`) — the wire shape is a superset.
- Default is `auth: 'sprite'` (private). Behavior at the URL, service running on its port:

  | Request | Result |
  |---|---|
  | No `Authorization` | **302** → `https://sprites.dev/auth/sprite?return_url=<signed>` (browser SSO), not 401 |
  | `Bearer <garbage>` | **302** to the same SSO flow (invalid ≡ absent) |
  | Raw Fly org token (`FlyV1 fm2_…`) as `Authorization` | **302** (Fly macaroons are NOT accepted at the URL) |
  | `Bearer <sprites-token>` | **200**, ~56ms — the minted org-scoped Sprites token IS the credential |

- `updateURLSettings({ auth: 'public' })` → next `getSprite` shows `{ auth: 'public' }` and
  the URL serves with no auth. `{ auth: 'sprite' }` restores the 302-for-anonymous behavior.
  Both verified live, effective immediately.
- **Consequence for the proxy task:** the same-origin proxy authenticates to the sprite URL
  with the `SPRITES_API_TOKEN` bearer header. A browser can never open the URL directly
  (it gets the SSO flow for an org it isn't in), which is exactly the v1 posture.

## 3. URL routing: **always port 8080** (verified — the headline surprise)

Run 3, distinct marker files per port, URL set `public` to remove auth noise:

| State inside the Sprite | `GET <sprite url>/` |
|---|---|
| Service `httpPort: 8000` **running**, nothing on 8080 | **hangs** — 25s+ timeout, no 502, no answer |
| Same, plus a plain (non-service) `python3 -m http.server 8080` | **200 `MARKER-8080-PLAIN`** — the 8080 process, not the service |
| Service stopped, 8080 process still up | 200 `MARKER-8080-PLAIN` |
| Service restarted via `startService` | still 200 `MARKER-8080-PLAIN` |

- The `httpPort` field on a service is persisted (comes back in `listServices`) but has **no
  observable routing effect**.
- **Start-on-request does not exist** in shipped behavior: with the service stopped, requests
  to the URL neither started it nor changed its state (checked before/after; state stayed
  `failed`). With *nothing* on 8080 the request hangs until client timeout — there is no
  fast failure to detect "no server" from outside.
- **Assumed** (not verified): 8080 is the documented default Sprite HTTP port; the docs'
  service-port routing may arrive in a later platform release. Re-verify before building
  anything on `httpPort`.
- **Consequence:** a previewable dev server must be reachable **on port 8080 in the Sprite**
  (bind it there, or relay to it). "Which service owns the preview" is a fact about port
  8080, not about any service row — the design doc's P1 conclusion survives with 8080
  substituted for "the httpPort slot".

## 4. Services lifecycle (verified)

- **`createService(name, {cmd, args, httpPort}, duration?)`** is a PUT
  (`/v1/sprites/{name}/services/{svc}`) that **auto-starts** the service and returns an
  NDJSON `ServiceLogStream`. With `duration: '5s'` the stream carried
  `{type:'started'}` … `{type:'complete', log_files:{combined|stdout|stderr:
  '/.sprite/logs/services/<name>.log'}}` (~5s apart — the stream stays open for the
  monitoring window). Note the wire field is **`log_files`** (snake_case); the SDK's
  `ServiceLogEvent` type says `logFiles` — **the type lies**, consume defensively.
- **`listServices()`** → `[{name, cmd, args, needs: [], httpPort?, state: {name, status,
  pid, started_at, next_restart_at}}]`. **`getService(name)`** → same but `needs: null`
  (list normalizes to `[]`, get returns the raw `null` — another types-vs-wire wobble; the
  `state` timestamps are snake_case strings, not the camelCase of the SDK's `ServiceState`).
- **State machine observed:** running → (`stopService`) → **`failed`** with
  `error: "exited with code 143"` — the runtime records the SIGTERM exit as a failure; the
  documented sticky-'stopped' state was never observed. → (`startService`) → `running` with
  a fresh pid. Stop **is** sticky in effect (nothing restarted it), but code that matches
  `status === 'stopped'` will never fire; treat `failed` + our own stopped-intent flag as
  the real signal.
- **`stopService`** stream: `stopping` → `stopped (exit_code: 143)` → `complete`. (The
  *stream event* says `stopped`; the *persisted state* says `failed`.)
- **Duplicate `httpPort`:** second service with `httpPort` on another port → accepted,
  started, no 409. Both listed as `running`.
- **`deleteService`** → 204; service gone from `listServices`.
- **Destroy with services defined:** `deleteSprite` succeeds normally; `getSprite` after →
  `APIError: sprite not found` (404). Services need no separate teardown.
- **Hibernate/wake:** see §6.

## 5. `port_opened` / `port_closed` exec-WS frames (verified)

- A dev server binding a port inside a **TTY session** (`createSession(..., {tty: true})` —
  the exact shape the realtime terminal uses) produces a TEXT control frame on that
  session's own WebSocket: `{"type":"port_opened","port":8124,"address":"10.0.0.1","pid":383}`
  — matching the SDK's `PortNotification` type. It arrives interleaved with `session_info`
  and `exit` frames via the SDK's `message` event, which our `SpriteCommandLike`
  already models (`on('message')`) and our consumers currently ignore.
- A **plain `spawn` (no TTY)** running the same server produced **zero** frames — in two
  separate runs. The SDK forwards every TEXT frame regardless of TTY (websocket.js emits
  `message` for any string payload), so the filter is **server-side**: the runtime only
  notifies TTY/session channels. Port detection must therefore hook the PTY path
  (realtime terminal), not the batch exec path.
- **`port_closed` was never observed** — killing the server and waiting (2s, then 8s in a
  second run, plus a post-exit listen window) produced no frame. Do not build teardown
  logic on `port_closed`; treat it as best-effort if it ever arrives.

## 6. Hibernation vs services (run 4, verified)

- A Sprite with a **running** service still pauses: status went `running` → `warm` within
  ~60–80s of idle (polled at 20s intervals). "Services don't block pause" is real.
- While paused (`warm`), `listServices` still answers (it's a control-plane read) and reports
  the frozen truth: `status: 'running'`, same pid.
- **An inbound URL request wakes the paused VM** — the fetch itself timed out (nothing on
  8080, §3) but the next `getSprite` showed `running`. Billing consequence for the proxy
  task confirmed: any proxied request is a wake, so wake-through-the-proxy must consult the
  same code-exec gate posture as session ensure.
- **Warm wake resumes the service process mid-flight**: same pid (22) before and after the
  pause — no restart, no state change. (Cold-boot restart behavior — the docs' "starts every
  service fresh" — was NOT observed in this spike's window: **assumed**, unverified.)

## 7. What this means for the seam (Part B) and downstream tasks

- **Safe to type and thread now** (verified operations only): `listServices`, `getService`,
  `createService`, `startService`, `stopService`, `deleteService`, `url`, `urlSettings`,
  `updateURLSettings` — plus surfacing `port_opened`/`port_closed` frames to a
  caller-provided listener on the exec WS (data only; TTY sessions are where they occur).
- **Do NOT build on** (diverges from docs/types): `httpPort` as a routing mechanism;
  start-on-request; the one-http-port 409; `status === 'stopped'`; `ServiceLogEvent.logFiles`
  (wire is `log_files`); `URLSettings` as an exact shape (wire adds `private_access`).
- **Decision for the proxy task** (flagged, not resolved here): the preview path is
  "our proxy + Bearer sprites-token → `https://<sprite>.sprites.app` → whatever listens on
  8080". Getting the user's dev server onto 8080 (run it there? in-sprite relay? revisit
  when platform ships httpPort routing?) is that task's call — posted as
  `[Q-preview-spike]`.

## 8. Addendum (2026-08-31): docs say httpPort/409/start-on-request ARE real — re-verified, they are NOT live

The published docs (`docs.sprites.dev/concepts/services`, fetched directly) are unambiguous and
internally consistent: *"The proxy routes incoming requests to port 8080 by default. Services with
`--http-port` override this routing target."*; a second `--http-port` service *"fails with `409:
another service already has an HTTP port configured`"*; and *"If the service isn't running when a
request arrives, the proxy starts it first, then forwards the request."* This directly contradicts
§2–3 above. Rather than take either the docs or the original spike on faith, ran one more decisive
test designed to rule out the two most likely explanations for the discrepancy:

- **Not an SDK bug**: every service-lifecycle call in this run was a hand-rolled `fetch()` — not
  `@fly/sprites` — hitting the exact endpoints/body shapes read directly out of the SDK's own
  source (`PUT /v1/sprites/{name}/services/{name}`, body `{cmd, args, httpPort}`;
  `PUT /v1/sprites/{name}` with `{url_settings: {auth}}`), so there is no daylight between "what the
  SDK sends" and "what this test sent."
- **Not propagation delay**: polled the sprite URL every 15s for **5 minutes** after creating the
  httpPort service (20 attempts) — every single attempt was a bare timeout, never a 502, never a
  200. Same pattern for start-on-request: polled for 3 minutes after stopping the service (12
  attempts) — never auto-started, service stayed `status: 'failed'` throughout.
- **Not stale tooling**: the fresh sprite created for this run reported `"version":"0.0.1-rc48"` —
  newer than both the pinned SDK (`0.0.1-rc37`) and the locally installed `sprite` CLI (`rc43`). The
  live platform itself, on its current version, does not exhibit the documented behavior.
- **New detail on the 409 claim**: retried the second-httpPort create three times. The retries
  don't even attempt-and-reject — they return `200` with `{"message":"Service already running with
  that command, use POST /v1/services/second/restart if you want to restart it"}`, i.e. the API
  treats a repeat of the identical request as an idempotent no-op, never as a conflict to reject.

**Conclusion — upgraded from "assumed" to "verified, repeatedly, two independent runs, raw API, long
polling windows": `httpPort` routing, the one-http-port 409, and start-on-request are documented
platform behavior that is NOT live on the API/runtime version this org can reach as of 2026-08-31.**
This is not a criticism of the SDK or this driver — it is a live platform/documentation gap, and
should be re-checked before anyone builds the proxy task against the assumption that it works. The
findings in §2–3 (URL always proxies port 8080; no scarcity; no start-on-request) stand as the
operative behavior to design against today.

## 9. Addendum (2026-08-31): ruled out "wrong config on our end"; discovered a better port-detection endpoint; found no hidden per-port routing

Before trusting either the docs or §8's re-verification, checked whether the gap could be explained
by something wrong with how PageSpace's own account is set up, rather than a platform/docs gap:

- **Not the wrong org**: `flyctl orgs list` shows exactly one org on this account (`2Wits`/`personal`).
  `flyctl apps list` confirms every production app (`pagespace-web`, `pagespace-realtime`, etc.) is
  owned by that exact same org — there is no separate, better-provisioned "company" Sprites org this
  spike missed.
- **Not the wrong token shape**: production's `resolveSpritesToken()` reads `SPRITES_API_TOKEN` into
  `new SpritesClient(token)` — the identical bearer-token shape minted here via
  `SpritesClient.createToken(macaroon, 'personal')`.
- **Not a billing/plan gate**: production apps are actively deployed and billed under this org, which
  rules out "unpaid trial account" as an explanation. No plan/beta/tier language appears anywhere in
  the docs for the services/httpPort/ports features.
- **Not stale docs vs. a newer platform**: `docs.sprites.dev/api/` resolves to `/api/v001-rc48/` —
  the exact runtime version (`0.0.1-rc48`) every freshly-created sprite in this investigation
  reported. The docs being read are documentation for the exact version being tested.
- **Not an ongoing platform incident**: Fly's own status page (`status.flyio.net`) shows no open or
  recent incident touching Sprites HTTP routing/services/proxy — the one Sprites-related incident in
  the last month (sprite deletion jobs failing, 2026-08-30 21:18–22:05 UTC) is unrelated and outside
  every test window here.

Also discovered a previously-missed API surface — `docs.sprites.dev/api/v001-rc48/ports/` documents
`WSS /v1/sprites/{name}/ports/watch`: *"Watch for port open/close events across all processes in the
sprite namespace. On connect, sends a snapshot of all currently listening ports as a `port_list`
message, then streams incremental `port_opened`/`port_closed` events."* The SDK does not wrap this
endpoint at all (grepped the dist — zero references). Tested it directly:

- **Correction to §5's finding**: `port_opened`/`port_closed` are NOT TTY-session-only. §5 concluded
  this from the exec-WS's own `message` channel, which genuinely is TTY-only (verified: a plain
  `spawn()` produced zero frames there). But the dedicated `ports/watch` WS saw a `port_opened` +
  `port_closed` pair for a **plain non-TTY `spawn()`** process within ~1.5s of it binding the port —
  a strictly more general, more reliable detection channel than the one wired into this PR's seam.
  **If/when the dev-server-detection decision core gets built, it should watch `ports/watch`, not
  the exec-WS message channel** — this seam's `onPortEvent` (TTY-only) should be treated as
  superseded, not extended.
- **The docs' example message is misleading**: the docs example shows
  `"address": "https://my-sprite.sprites.dev:3000"` (a routable per-port URL), which would have been
  a completely different — and much simpler — path to a working preview (watch for the port, hit its
  own URL directly, no Services/httpPort involved at all). The ACTUAL wire response only ever
  contained `"address": "10.0.0.1"` — the sprite's internal IP, matching exactly what the exec-WS
  channel already showed in §5 of the original spike. **There is no hidden per-port public URL.**
  `ports/watch` is a notification-only channel; it does not make a port externally reachable.

**Net effect on the open question**: the "wrong config" and "secret per-port URL" hypotheses are
both ruled out. The httpPort/409/start-on-request gap from §8 stands, now with corroborating context
(matching API version, no incident, no plan gate) rather than a plausible alternate explanation. The
one channel genuinely not checkable from here: an account-level feature flag invisible to `flyctl`,
the `sprite` CLI, and the public docs — only Fly support or a Sprites account dashboard could confirm
or rule that out.

## Appendix: raw evidence

Scratch scripts (`spike-services{,-2,-3,-4}.mjs`) and full logs lived in the session
scratchpad; sprites `ps-spike-preview-mtf27zhe`, `ps-spike2-mtf9pca8`, `ps-spike3-mtf9s2gb`,
`ps-spike4-…` all verified deleted. Key raw shapes:

```jsonc
// getService('devserver') while running
{ "name": "devserver", "cmd": "python3",
  "args": ["-m", "http.server", "8000", "--directory", "/srv-spike"],
  "needs": null,
  "state": { "name": "devserver", "status": "running", "pid": 26,
             "started_at": "2026-08-30T00:17:15.307030906Z",
             "next_restart_at": "0001-01-01T00:00:00Z" } }

// after stopService
{ "state": { "status": "failed", "error": "exited with code 143", ... } }

// TTY-session control frames while a server binds/dies
{ "type": "session_info", "session_id": "58", "command": "sh", "tty": true, ... }
{ "type": "port_opened", "port": 8124, "address": "10.0.0.1", "pid": 383 }
{ "type": "exit", "exit_code": 0 }   // no port_closed, ever

// anonymous request to a private (auth: 'sprite') URL
// 302 Location: https://sprites.dev/auth/sprite?return_url=<signed-token>
```
