# Spike: Sprites trusted transport — can the guest be given, or present, an unforgeable identity?

> **Date:** 2026-09-14/15 · **SDK:** `@fly/sprites@0.0.1-rc37` · **Runtime:** `0.0.1-rc48` · **API:** `https://api.sprites.dev`
> **Epic:** Agent Accounts & Credential Broker (`j471yhv7p3abea7mlxrchdu1`) · **Task:** S1 (`axszfbs35hufmpifquwu776z`) · **Register:** Λ6 · **Decision fed:** D-18, G4 entry.
> **Why:** Codex's review (`km6yrydf0sc08g6ikoikno7f`, "Sandbox identity cannot come from an unstealable bearer token inside a hostile VM") makes caller identity the load-bearing question for L4/G4. If Sprites cannot give the provisioner a channel the guest cannot forge, credentialed operations must originate from the server-side tool runner. This spike verifies, against a real sprite, which identity a guest request carries, whether a per-sprite channel can be bound outside the guest, and whether a sprite instance id is observable and replay-safe.
> **Method:** two real, billed sprites driven end-to-end with an org-minted token (`flyctl tokens create org` → `SpritesClient.createToken`), both deleted in teardown and the deletion verified (`getSprite` → `sprite not found`; `listAllSprites("ps-s1-")` → `[]`). Every claim is marked **verified** (observed on the wire) or **assumed** (docs/types/prior-spike only). The header-echo origin plus a laptop-baseline request is the control that makes every absence meaningful — see [[real-sandbox-verification]].

## TL;DR — the four questions, answered

1. **No request attribute reaching *our* origin authenticates the guest.** Every header the guest sends is guest-authored, including `Authorization`, `X-Forwarded-For`'s head, `X-Forwarded-Proto/Port/Ssl`, and any `X-Sprite-Id`/`X-Sprite-Name` — all passed through to a plain origin unchanged (**verified**). The one attribute the guest cannot forge, `Sprite-Client-Ip`, is set by the *sprite inbound edge* and only exists for a server sitting *behind* `<name>.sprites.app` — which our real origin is not. Source IP at a real origin is the sprite's shared-NAT egress IP (differs per instance, but a shared pool, not an identity). **Codex's premise holds: an edge hostname, source IP, or claimed sprite id does not authenticate a guest.**
2. **A per-sprite channel CAN be bound outside the guest — but only server→guest.** The provisioner's exec, `createSession`, and `proxyPort`/WebSocket channels are all server-initiated, authenticated by the org Sprites token (which never enters the guest) and addressed by sprite *name* in the API path. A raw WebSocket to `/v1/sprites/{name}/proxy` **opened with the org token and was rejected with a forged token and with no token** (**verified**). There is **no** guest→server channel on which guest-resident code can present an identity: the guest cannot reach the control plane at all (`api.sprites.dev` → 401 with no/forged token; the `10.0.0.1` gateway refuses every port; every metadata endpoint times out or is refused) (**verified**).
3. **The sprite instance id is observable server-side and is replay-safe across reclaim, but not confidential.** `createSprite`/`getSprite` return `.id` (`sprite-<uuid>`) (**verified**). It **survives an in-place checkpoint/restore unchanged** and **changes on delete + recreate under the same name** (new id, wiped filesystem) (**verified**) — exactly the ABA guard `machine-sprite-reclaims.spriteInstanceId` and `SandboxHandle.spriteInstanceId` depend on. But the guest can also read its own id from the world-accessible `/.sprite/api.sock` `/info` endpoint with no token (**verified**), so the id binds a grant to one generation; it is not a secret.
4. **Recommendation for G4: server-side runner originates every credentialed operation (D-18 relay); do not place any bearer or presenter key inside the guest.** The trusted server→guest channel is real and is the correct transport for the relay, and the grant should bind the sprite `instance id` (observable, ABA-safe). The "guest asks the broker for a credential" pattern has no unforgeable guest→server identity channel and must not be built in G4. This is the fallback Codex named ("initially originate credentialed operations from the server-side tool runner"), and here it is the *primary* recommendation because the guest is root.

---

## 1. Setup (verified)

- **Token:** `flyctl tokens create org -o personal -x 2h` → strip the leading `FlyV1 ` → `SpritesClient.createToken(macaroon, 'personal')` → a `personal…`-prefixed token (114 chars). `new SpritesClient(token)` takes the token **positionally**.
- **Sprites:** `ps-s1-origin-85d21b68` (header-echo origin) and `ps-s1-guest-85d21b68` (hostile guest). Names are 20 chars, well under the 48-char `SPRITE_NAME_MAX` that keeps `<name>-<org>` a legal DNS label (see [[sprite-url-label-too-long]]).
- **Image:** `python3`, `node`, `bun`, plus a large language toolchain under `/.sprite/bin`; kernel `6.12.105-fly` x86_64; org `2wits`.
- **Exec discipline:** every `execFile('sh', ['-c', …])` ran with a 40 s cap — the exec socket lingers 5–10 s after the process exits, so a cap under ~15 s never succeeds (see [[sprites-exec-socket-lingers-after-exit]]). `mkdir -p /srv; cd /srv;` prefixes every script because `/workspace` does not exist on a fresh sprite.
- **Billing window:** origin created `2026-09-15T02:35:12.837Z`, deleted `2026-09-15T02:44:13.067Z`. Guest created `2026-09-15T02:35:13.180Z`, recreated (generation test) `2026-09-15T02:43:39.791Z`, deleted `2026-09-15T02:44:13.478Z`. Both verified gone; `listAllSprites("ps-s1-")` returned `[]`.

## 2. What identity reaches the origin, and what the guest can forge (verified)

The origin ran a header-echo server on port 8080 (`auth: 'public'`, so no auth noise). Three requests were compared: a laptop baseline, an honest guest request, and a guest request with every plausible identity header forged. The full header sets echoed at the origin:

| Header at origin | Laptop baseline | Guest honest | Guest forged (what it sent) | Edge behaviour |
|---|---|---|---|---|
| `Sprite-Client-Ip` | `66.52.44.39` (laptop public IP) | `fdaa:c4:ae3d:a7b:…` (guest 6PN) | sent `203.0.113.9` → **arrived `fdaa:c4:…`** | **Edge overwrites** — the one attribute the guest cannot forge, but only visible *behind the sprite edge* |
| `X-Forwarded-For` | `66.52.44.39, 169.155.48.226, 172.16.3.42` | `fdaa:c4:…, 2a09:8280:1::…, 172.16.3.42` | sent `203.0.113.7` → **arrived `203.0.113.7, fdaa:c4:…, …`** | Edge **prepend-preserves** the forged head, appends real hops — head is guest-controlled |
| `Via` | `1.1 fly.io` | `1.1 fly.io` | sent `1.1 forged` → **arrived `1.1 forged, 1.1 fly.io`** | Edge appends its own; guest value survives |
| `X-Forwarded-Proto` / `-Port` / `-Ssl` | `https` / `443` / `on` | `https` / `443` / `on` | proto-forge run sent `http` / `80` / `off` → **arrived `http` / `80` / `off`** | Edge does **not** normalize — fully guest-forgeable |
| `Authorization` | (absent) | (absent) | sent `Bearer forged-by-guest` → **arrived `Bearer forged-by-guest`** | Passed through in `auth: 'public'`. Consumed/stripped only in `auth: 'sprite'` (see §2.1) |
| `X-Sprite-Id` / `X-Sprite-Name` | (absent) | (absent) | sent `sprite-forged` / `pgs-ses-forged` → **arrived unchanged** | Edge injects **no** trustworthy sprite-id header; any such header is guest-authored |
| `X-Request-Start` | `t=1789439722545929` | edge value | sent `t=0` → **arrived `t=0`** | Guest-forgeable |

**Reading of the table.** To a server that is *not* behind the sprite edge — which is what our credential broker / real origin is — the guest presents nothing but a plain TLS client with entirely self-authored headers. The `Sprite-Client-Ip` the edge sets authoritatively is useless to us: it is only present on requests that *transit* `<name>.sprites.app`, and it identifies the sprite to a server that already sits inside that trust path. Our origin sees only the sprite's egress IP.

### 2.1 The sprite egress IP is not an identity (verified)

From inside, `api.ipify.org` reported **guest egress `152.233.40.68`** and **origin egress `69.31.3.106`** — distinct per instance, but a shared Fly NAT pool (see `egress-ip.ts`: sandbox egress should leave via a dedicated tagged IP precisely because the default pool is shared). A guest request to our real origin (`https://pagespace.ai/api/health`) succeeded (`{"status":"healthy",…}`) carrying nothing that names the sprite. And to a neutral third-party origin (`httpbin.org`) the guest's **forged** `Sprite-Client-Ip: 203.0.113.9`, `Authorization`, and `X-Sprite-*` all passed through untouched — confirming those headers are the guest's to write whenever the request does not transit the sprite edge.

### 2.2 `auth: 'sprite'` rejects a forged bearer at the edge (verified)

With the origin switched to `auth: 'sprite'`, a guest request carrying `Authorization: Bearer forged-by-guest` did **not** reach the echo server — it received the Fly SSO/authentication response instead. So the edge validates the org token before forwarding and a forged bearer never crosses it. This corroborates the prior finding that the edge *strips* `Authorization` before forwarding a validly-authenticated request (see [[real-sandbox-verification]]): the credential the preview proxy sends is not readable by a previewed server. This spike adds that an *invalid* bearer is rejected outright rather than forwarded.

## 3. Can a per-sprite secret or channel be bound outside the guest? (verified)

### 3.1 The guest is a fully hostile root principal

`sudo -n id` → `uid=0(root)`. The guest has passwordless root, `CapEff: 00000000a82435fb`, and the standard suid set. **Any secret placed inside the guest filesystem or environment is readable** — this is the stated threat model, now confirmed on this platform. `pid 1` is `/.pilot/tini -- tail -f /dev/null`; its environment carries only generic vars (`PATH`, `HOME`, `SPRITE_STORAGE_DRIVER`, …) — no token, and in any case root can read all of it.

### 3.2 `/.sprite/api.sock` — world-accessible, but read-only and single-sprite (verified)

The guest sees a UNIX socket `/.sprite/api.sock` (mode `srw-rw-rw-`). Probed directly over the socket with no token:

| Request | Result |
|---|---|
| `GET /info` | **200** `{"sprite_id":"sprite-ea0cc07a-…","sprite_name":"ps-s1-guest-…","sprite_url":"…","version":"0.0.1-rc48","org":""}` |
| `GET /v1/checkpoints` | **200** — lists this sprite's checkpoints |
| `GET /v1/services` | **200** `[]` |
| `POST /v1/checkpoints` (create) | **405 Method Not Allowed** |
| `POST /v1/services` (create) | **405 Method Not Allowed** |
| `POST /v1/exec`, `POST /v1/sessions` | **404 Not Found** |
| `GET /v1/sprites/<other-sprite>/info` | **404** — no cross-sprite reach |
| `GET /v1/token`, `/v1/identity`, `/v1/policy` | **404** |

So the local pilot socket is a **read-only status surface scoped to this one sprite**. The guest learns its own `sprite_id` (so the instance id is *not confidential*) but cannot mint a token, exec, create sessions/services, restore a checkpoint, or address another sprite through it. (The `sprite-env` CLI in `/.sprite/bin` performs checkpoint/service *mutations*, and the SDK performs them via the control plane with the org token — not reachable here without that token. `POST /v1/checkpoints` returning 405 rather than 401 indicates the create verb lives on a different path/method the socket does not expose to this caller.)

### 3.3 No host metadata endpoint, no gateway reach (verified)

Interfaces: `lo`, and `spr0` at `10.0.0.1/24` with gateway `10.0.0.2` (also the DNS resolver). Probes from the guest:

- `169.254.169.254/`, `169.254.169.254/latest/meta-data/`, `http://[fdaa::3]/` → **timeout**; `_api.internal` → timeout; `api.internal` → NXDOMAIN. **No cloud/Fly metadata endpoint is reachable.**
- `10.0.0.1` (gateway) TCP ports 22/80/443/8080/9000 → **all Connection refused.** There is no host-side HTTP service the guest can call.
- `api.sprites.dev/v1/sprites` with no token → **401**; with a forged bearer → **401.** The guest cannot impersonate the org against the control plane.

### 3.4 The server→guest channel the provisioner *can* bind (verified)

The provisioner's channels are all initiated from outside the guest and authenticated by the org token in the API path, keyed on the sprite name:

- **exec / `createSession` / `attachSession`** — every command this spike ran is a server-initiated WebSocket the guest cannot originate; the guest sees only the resulting process.
- **`proxyPort` → `WSS /v1/sprites/{name}/proxy`** — tested directly with a raw WebSocket:

  | Presenter | Result |
  |---|---|
  | Org Sprites token | **OPEN** + `{"status":"connected","target":"10.0.0.1:9911"}` — a live TCP tunnel into the guest |
  | `Bearer forged-by-guest` | **handshake rejected** (never opened) |
  | No token | **handshake rejected** (never opened) |

  (The SDK's `ProxySession.start()` has a dual-stack `localhost` bind bug on macOS — `EADDRINUSE` on a fresh port — and the repo does not use `proxyPort`; the raw-WebSocket test above is the clean demonstration of the endpoint's auth.)

**This is the trusted-transport primitive.** Its identity is established by the org token the *server* holds and by the sprite *name + instance id* the server can independently verify via `getSprite` — none of which the guest can produce. But it is a channel the server drives *into* the guest. There is no reciprocal channel on which guest-resident code authenticates *itself* to the broker.

## 4. Is the instance id observable and replay-safe? (verified)

The guest wrote a marker, then the sprite was put through two "generation" events:

| Event | Instance id before | Instance id after | Filesystem | Verdict |
|---|---|---|---|---|
| In-place `createCheckpoint` → `restoreCheckpoint` | `sprite-ea0cc07a-…` | **`sprite-ea0cc07a-…` (same)** | rolled back to the checkpoint | Restore **preserves** the instance id |
| `deleteSprite` → `createSprite` (same name) | `sprite-ea0cc07a-…` | **`sprite-10f45656-…` (new)** | **wiped** (`NO-MARKER`) | Reclaim/recreate **changes** the instance id |

The id is returned server-side on both `createSprite` and `getSprite` (raw wire field `id`). Therefore a grant bound to `(sprite name, instance id)`:

- **survives** a legitimate warm resume and an in-place restore (the id is stable), and
- **fails closed** when replayed against a sprite that was reclaimed and recreated under the same name (the id no longer matches) — the ABA case `machine-sprite-reclaims.spriteInstanceId` exists to defend, now confirmed to actually change.

Pause/wake (`warm`) was observed during the restore run to keep the same id with `last_running_at` advancing; the prior services spike (`docs/spikes/2026-08-dev-preview-sprite-services-spike.md` §6) already established that a warm wake resumes the same process/pid. Cold-boot behaviour after a long pause was not exercised here (**assumed** stable id, since only delete/recreate mints a new `sprite-<uuid>`).

## 5. Recommendation for G4 (reasoning chain explicit)

**Claim: G4 must originate every credentialed operation from the server-side tool runner (the D-18 relay), and must not place any bearer, presenter key, or credential inside the guest. The trusted server→guest channel is the relay's transport, and the grant binds the sprite instance id.**

The chain that forces this:

1. **The guest is root and the local socket is world-readable (§3.1–3.2).** So the classic mitigations for a leaked bearer — file permissions, a protected daemon, a hidden env var — all fail: root reads everything, and `/.sprite/api.sock` is reachable by any process. *Therefore a secret at rest inside the guest is extractable* — Codex's premise, verified, not assumed.
2. **The guest cannot authenticate itself to anything outside the VM (§3.3).** No metadata endpoint, no gateway service, and the control plane rejects it. *Therefore there is no surface on which guest code could present a workload identity the way SPIFFE/SPIRE would* — installing identity machinery inside the same root-controlled guest establishes no boundary, exactly as Codex warned.
3. **But the provisioner already holds a channel the guest cannot forge (§3.4).** exec / session / proxy are server-initiated, org-token-authenticated, name-and-instance-addressed. *Therefore the broker does have trustworthy caller identity for the sandbox — it is "this specific sprite instance, provisioned by this server for this run".* The identity comes from the binding the provisioner controls, not from request parameters.
4. **That channel is server→guest, not guest→server (§3.4).** The server pushes commands and reads output; guest-resident code has no channel to *ask* the broker for a credential and be identified. *Therefore the credentialed operation must be decided and executed on the server side*, where the org token, the grant, and the origin pin live, using the sandbox only as the execution surface the server reaches over the trusted channel.
5. **The instance id is observable and ABA-safe (§4).** *Therefore the grant can bind `sandbox instance + generation` (as the epic's grant shape already lists) so a grant replayed against a reclaimed sprite fails closed* — and because the id is not confidential (§3.2), the grant's *security* rests on the org-token channel and the digest binding, never on the id being secret.

**So the L4 posture is:** the Git relay and the CLI relay run in the server-side tool runner; they resolve the credential inside the credential plane and reach into the sandbox over the exec/session channel; the sandbox never receives, requests, or holds the credential. The raw `GH_TOKEN` injection (Λ1) is removed here, as the gate ledger already requires. This is not a compromise fallback — given a root guest it is the *only* arrangement that satisfies invariant 1 (reference, never value).

**Fallback / future (out of scope for G4, flagged for L7+):** if a later phase genuinely needs guest-*initiated* credentialed egress (the guest's own code triggering an authenticated fetch), it must terminate at a host-side egress gate that substitutes the real credential *after* authorizing the concrete request — the "Sentinel" end state D-18 points at. Its authority must come from the connection binding the *server* holds (the same exec/proxy channel identity proven here), never from anything the guest sends, and the whole guest remains one hostile principal, so each operation is still narrowly scoped and, on write, approved. Nothing in this spike suggests a private key or bearer inside the guest could ever substitute for that gate.

**What would change this recommendation:** a Sprites primitive that (a) lets the *server* inject a per-connection secret the guest process can read but that is bound to the instance and unreadable across a reclaim, *and* (b) gives guest code an authenticated channel back to the broker keyed on that binding. Neither exists on `0.0.1-rc48` today: the only host-side surface the guest can reach is the read-only status socket (§3.2), and it exposes no such secret and no back-channel. Re-run §3.2–3.4 before assuming any newer runtime adds one.

## 6. Reproduction

All scripts ran from a scratchpad, importing the SDK by absolute path from `apps/web/node_modules/@fly/sprites/dist/index.js` (no `node_modules` created in this worktree). To reproduce:

```sh
# 1. mint tokens
flyctl tokens create org -o personal -x 2h > fly-org-token.txt          # strip leading "FlyV1 "
node -e 'import("<repo>/apps/web/node_modules/@fly/sprites/dist/index.js").then(async ({SpritesClient})=>{
  const m=require("fs").readFileSync("fly-org-token.txt","utf8").trim().replace(/^FlyV1\s+/,"");
  require("fs").writeFileSync("sprites-token.txt", await SpritesClient.createToken(m,"personal")); })'

# 2. create two sprites (names <= 48 chars), start a header-echo server on 8080 of the origin,
#    set the origin URL auth:'public', and record the laptop baseline request.
# 3. guest phase: from inside the guest, fetch the origin URL honestly and with every identity
#    header forged; fetch httpbin + pagespace.ai; read api.ipify.org for the egress IP.
# 4. readable phase: id; sudo -n id; env; /proc/1/environ; probe /.sprite/api.sock verbs;
#    probe 169.254.169.254, [fdaa::3], api.internal, 10.0.0.1:{22,80,443,8080,9000};
#    hit api.sprites.dev with no/forged token.
# 5. tunnel phase: raw WSS to api.sprites.dev/v1/sprites/{name}/proxy with org / forged / no token.
# 6. generation phase: createCheckpoint -> restoreCheckpoint (compare .id); deleteSprite ->
#    createSprite same name (compare .id and filesystem marker).
# 7. teardown: deleteSprite both; getSprite must throw "sprite not found"; listAllSprites("<prefix>") == [].
```

Exec caps were 40 s throughout (never under ~15 s — the exec socket lingers 5–10 s after exit). Every fetch used a 15 s client timeout so a hung probe (e.g. a metadata endpoint) fails fast rather than hanging the run. The scratchpad probe (`s1-probe.mjs`, `ws-proxy.mjs`, `echo-server.py`, `fetch.py`) and the raw NDJSON echo log are the reproduction recipe.

## 7. Related findings

- [[real-sandbox-verification]] — token recipe; the edge strips `Authorization` on a validly-authenticated `auth:'sprite'` request; `new SpritesClient(token)` is positional.
- [[sprites-exec-socket-lingers-after-exit]] — never cap an exec under ~15 s.
- [[sprite-url-label-too-long]] — keep the sprite name ≤ 48 chars.
- [[sprites-ports-watch-blind-to-nextjs]] — the ports/watch snapshot is positive-only evidence.
- `docs/spikes/2026-08-dev-preview-sprite-services-spike.md` — the services/URL/8080-routing surface this spike builds on.
