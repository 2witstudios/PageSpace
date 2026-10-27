# Spike: Sprites trusted transport — can the guest be given, or present, an unforgeable identity?

> **Date:** 2026-09-14/15 · **SDK:** `@fly/sprites@0.0.1-rc37` · **Runtime:** `0.0.1-rc48` · **API:** `https://api.sprites.dev`
> **Epic:** Agent Accounts & Credential Broker (`j471yhv7p3abea7mlxrchdu1`) · **Task:** S1 (`axszfbs35hufmpifquwu776z`) · **Register:** Λ6 · **Decision fed:** D-18, G4 entry.
> **Why:** Codex's review (`km6yrydf0sc08g6ikoikno7f`, "Sandbox identity cannot come from an unstealable bearer token inside a hostile VM") makes caller identity the load-bearing question for L4/G4. If Sprites cannot give the provisioner a channel the guest cannot forge, credentialed operations must originate from the server-side tool runner. This spike verifies, against a real sprite, which identity a guest request carries, whether a per-sprite channel can be bound outside the guest, and whether a sprite instance id is observable and replay-safe.
> **Method:** two real, billed sprites driven end-to-end with an org-minted token (`flyctl tokens create org` → `SpritesClient.createToken`), both deleted in teardown and the deletion verified (`getSprite` → `sprite not found`; `listAllSprites("ps-s1-")` → `[]`). Every claim is marked **verified** (observed on the wire) or **assumed** (docs/types/prior-spike only). The header-echo origin plus a laptop-baseline request is the control that makes every absence meaningful — see [[real-sandbox-verification]].

## TL;DR — the four questions, answered

1. **No request attribute reaching *our* origin authenticates the guest.** Every header the guest sends is guest-authored, including `Authorization`, `X-Forwarded-For`'s head, `X-Forwarded-Proto/Port/Ssl`, and any `X-Sprite-Id`/`X-Sprite-Name` — all passed through to a plain origin unchanged (**verified**). The one attribute the guest cannot forge, `Sprite-Client-Ip`, is set by the *sprite inbound edge* and only exists for a server sitting *behind* `<name>.sprites.app` — which our real origin is not. Source IP at a real origin is the sprite's shared-NAT egress IP (differs per instance, but a shared pool, not an identity). **Codex's premise holds: an edge hostname, source IP, or claimed sprite id does not authenticate a guest.**
2. **A per-sprite channel CAN be bound outside the guest — but only server→guest.** The provisioner's exec, `createSession`, and `proxyPort`/WebSocket channels are all server-initiated, authenticated by the org Sprites token (which never enters the guest) and addressed by sprite *name* in the API path. A raw WebSocket to `/v1/sprites/{name}/proxy` **opened with the org token and was rejected with a forged token and with no token** (**verified**). The guest cannot **originate** an authenticated connection to anything outside the VM: it cannot reach the control plane at all (`api.sprites.dev` → 401 with no/forged token; the guest's own `spr0` address `10.0.0.1` refuses every probed port, while the real gateway `10.0.0.2` was used only as the DNS resolver and **not port-probed**; every metadata endpoint times out or is refused). The control-plane and metadata results are **verified**. The conclusion that the guest cannot originate an authenticated connection is **not verified**: an unprobed gateway could expose an instance-bound metadata or relay service that authenticates the caller from its VM or network attachment, without any guest-held credential. G4 narrows it by enumerating the gateway's reachable surface (§3.3), and the conclusion then holds only for the ports and protocols that probe actually covers. But a channel the server opens is **duplex**: once the provisioner holds a proxy tunnel, WebSocket or exec stream to a named sprite, the bytes the guest sends back over it (request bytes into the tunnel, stdout on an exec) arrive on a connection the *server* authenticated and bound to sprite name + instance id. Guest-originated *requests* can therefore carry a server-established identity — the identity is "this sprite instance", established by the server's binding, never by anything the guest presents. (*Amended 2026-09-15*: the first draft said no guest→server authenticated channel exists, which conflated *originating* a channel with *having* one.)
3. **The sprite instance id is observable server-side and is replay-safe across delete/recreate reclaim, but not confidential.** `createSprite`/`getSprite` return `.id` (`sprite-<uuid>`) (**verified**). It **survives an in-place checkpoint/restore unchanged** and **changes on delete + recreate under the same name** (new id, wiped filesystem) (**verified**) — exactly the ABA guard `machine-sprite-reclaims.spriteInstanceId` and `SandboxHandle.spriteInstanceId` depend on. But the guest can also read its own id from the world-accessible `/.sprite/api.sock` `/info` endpoint with no token (**verified**), so the id binds a grant to one *incarnation* (delete/recreate), not to a restore generation, and it is not a secret. Because restore keeps the id, **no observed field changes on restore**: "generation" must be a server-side counter that the provisioner bumps on every `restoreCheckpoint` (and recreate), stored beside the instance id (§4).
4. **Recommendation for G4: relay-only is the simplest v1 — the server-side runner originates every credentialed operation (D-18 relay) and no bearer or presenter key is placed inside the guest. If L4 needs guest-originated requests, the caller-identity primitive is a server-opened, bound duplex channel (§3.4): the broker identifies the caller as "this sprite instance" from the binding the server holds, never from request contents.** Caveats that apply to the duplex design: the channel identifies the *sprite*, not a benign process — every byte on it is root-authored and the whole guest stays one hostile principal, so each request is still narrowly scoped, digest-authorized and approved on write; replay/generation binding (instance id + generation, §4, re-checked at presentation) is still required; and a channel must not outlive the generation it was opened against. The grant binds the sprite `instance id` (observable, ABA-safe) in either design. What must not be built is the "guest *presents* its own identity" pattern (a guest-held bearer, SPIFFE inside the guest): no guest-originated authenticated channel was found for it to ride (control plane and metadata verified; gateway `10.0.0.2` unprobed, G4). Relay-only is the fallback Codex named ("initially originate credentialed operations from the server-side tool runner"); here it is the *primary* v1 because it has the fewest moving parts, with the duplex channel as the recorded alternative — decision deferred to G4 (ADR 0006 Amendment 2026-09-15).

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

## 3. Can a per-sprite secret or channel be bound outside the guest? (verified, except gateway reach — §3.3)

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

### 3.3 No host metadata endpoint (verified); gateway reach not probed

Interfaces: `lo`, and `spr0` at `10.0.0.1/24` with gateway `10.0.0.2` (also the DNS resolver). Probes from the guest:

- `169.254.169.254/`, `169.254.169.254/latest/meta-data/`, `http://[fdaa::3]/` → **timeout**; `_api.internal` → timeout; `api.internal` → NXDOMAIN. **No cloud/Fly metadata endpoint is reachable.**
- `10.0.0.1` TCP ports 22/80/443/8080/9000 → **all Connection refused.** *Corrected 2026-09-16 (PR #2633 round 4):* this is the guest's **own** `spr0` address, the one the org-token proxy tunnel targets (`10.0.0.1:9911`, §3.4), not the gateway. The probe shows only that nothing in the guest listens on those ports. The gateway `10.0.0.2` answered DNS but was **not port-probed**, so "no host-side service the guest can call" is **not verified**. G4 must enumerate the gateway's reachable surface from the guest before relying on it: a full TCP scan (1–65535), a UDP sweep, and the link-local and IPv6 equivalents. The conclusion is then stated **only for the ports and protocols covered**, and anything not covered is named as residual. Results fall into three classes: **open**, meaning any application response, such as the DNS reply already observed on `10.0.0.2:53`, which is surface to investigate; **closed**, meaning a TCP RST or an ICMP port-unreachable; and **residual**, meaning a silent, open|filtered or filtered result, which never counts as absence. The control-plane result below does not depend on this: a host-side service would still need to authenticate the guest, and nothing the guest holds is a credential.
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

**This is the trusted-transport primitive.** Its identity is established by the org token the *server* holds and by the sprite *name + instance id* the server can independently verify via `getSprite` — none of which the guest can produce. The server opens it; the guest cannot (§3.3). But once open it is **duplex**: the proxy tunnel carries whatever the guest sends to the tunnelled port back to the server, and an exec stream carries stdout/stderr back — all on the connection the server authenticated and bound to `(name, instance id)`. So two statements must be kept apart:

- *The guest cannot **originate** an authenticated connection*. Verified for the Sprites control plane (forged/no-token handshakes above) and the probed metadata endpoints. **Not verified** for the gateway `10.0.0.2`, which was never port-probed. An instance-bound service there could authenticate the guest by its attachment (§3.3, G4).
- *The guest has **no** authenticated channel to the server* — **false once the server opens one**: guest-originated bytes over a server-opened channel carry the server-established identity of that sprite instance.

What the duplex channel does *not* give: it identifies the sprite, not a benign process inside it (root authors every byte), it says nothing about *which* request is legitimate (digest authorization is still per request), and it is only as fresh as its binding (a channel opened before a restore or recreate must be torn down — §4). (*Amended 2026-09-15*: the first draft's last sentence, "there is no reciprocal channel on which guest-resident code authenticates itself", was an overstatement; corrected per PR #2633 review.)

## 4. Is the instance id observable and replay-safe? (verified)

The guest wrote a marker, then the sprite was put through two "generation" events:

| Event | Instance id before | Instance id after | Filesystem | Verdict |
|---|---|---|---|---|
| In-place `createCheckpoint` → `restoreCheckpoint` | `sprite-ea0cc07a-…` | **`sprite-ea0cc07a-…` (same)** | rolled back to the checkpoint | Restore **preserves** the instance id |
| `deleteSprite` → `createSprite` (same name) | `sprite-ea0cc07a-…` | **`sprite-10f45656-…` (new)** | **wiped** (`NO-MARKER`) | Delete/recreate reclaim **changes** the instance id |

The id is returned server-side on both `createSprite` and `getSprite` (raw wire field `id`). Therefore a grant bound to `(sprite name, instance id)`:

- **survives** a legitimate warm resume and an in-place restore (the id is stable). The restore case is acceptable only for relay-only grants that bind nothing restore-sensitive. Any binding that must not outlive a restore (the duplex channel, caveat (ii) in §5) needs the provisioner-owned generation counter, because the instance id alone **cannot detect a restore**, and
- **fails closed** when replayed against a sprite that was **deleted and recreated** under the same name (the id no longer matches). That is the one reclaim path this probe exercised, and it is the path the repo performs: `machine-sprite-reclaims` drains by a name-keyed kill (a delete) and the next provision is a fresh `createSprite`, which is exactly the ABA case `machine-sprite-reclaims.spriteInstanceId` guards — now confirmed to actually change. Other ways a sprite could be replaced under the same name — platform-side eviction, a cold boot after a long pause, host migration — were **not** exercised, so no replay-safety claim is made for them here (see the next paragraph).

Pause/wake (`warm`) was observed during the restore run to keep the same id with `last_running_at` advancing; the prior services spike (`docs/spikes/2026-08-dev-preview-sprite-services-spike.md` §6) already established that a warm wake resumes the same process/pid. **Not verified:** cold boot after a long pause, platform eviction, and host migration — whether any of these keeps the id (a stable id there is a *convenience* assumption for grant longevity, not a security assumption: an unexpected id change fails closed, an unexpected id *reuse* across a wiped filesystem would be the only dangerous case, and nothing observed suggests the platform re-mints `sprite-<uuid>` values). G4 must re-run the §4 marker probe across a forced cold boot before a grant lifetime longer than a warm-pause window is relied on.

## 5. Recommendation for G4 (reasoning chain explicit)

**Claim: relay-only — the server-side tool runner originates every credentialed operation (the D-18 relay) — is the simplest correct v1 for G4, and G4 must not place any bearer, presenter key, or credential inside the guest. If L4 needs guest-originated requests, the caller-identity primitive is a server-opened, bound duplex channel (§3.4), under the caveats below; the decision between the two is deferred to G4. In either design the trusted server→guest channel is the transport and the grant binds the sprite instance id + generation.**

The chain that forces this:

1. **The guest is root and the local socket is world-readable (§3.1–3.2).** So the classic mitigations for a leaked bearer — file permissions, a protected daemon, a hidden env var — all fail: root reads everything, and `/.sprite/api.sock` is reachable by any process. *Therefore a secret at rest inside the guest is extractable* — Codex's premise, verified, not assumed.
2. **The guest cannot authenticate itself to anything outside the VM (§3.3).** No metadata endpoint was found and the control plane rejects the guest. The gateway `10.0.0.2` was not port-probed (§3.3), so this premise is **unverified until G4 probes it**. If the gateway exposes an instance-bound service, the conclusion below must be revisited. *Therefore no surface was found on which guest code could present a workload identity the way SPIFFE/SPIRE would. That holds for the control plane and the probed metadata endpoints; the gateway's full service surface is unexamined until G4 enumerates it, and the claim covers only what that enumeration tests. The gateway, and any guest-originated back-channel through it, stay explicitly **unresolved** until G4 completes* — installing identity machinery inside the same root-controlled guest establishes no boundary, exactly as Codex warned.
3. **But the provisioner already holds a channel the guest cannot forge (§3.4).** exec / session / proxy are server-initiated, org-token-authenticated, name-and-instance-addressed. *Therefore the broker does have trustworthy caller identity for the sandbox — it is "this specific sprite instance, provisioned by this server for this run".* The identity comes from the binding the provisioner controls, not from request parameters.
4. **That channel is server-opened and duplex (§3.4).** The guest cannot originate one; but bytes the guest sends back over one the server opened are attributable, by the server's own binding, to that sprite instance. *Therefore two designs are sound, and both keep the decision and the credential on the server side*: (a) **relay-only** — the server decides and executes the operation and uses the guest only as the execution surface it reaches over the channel; (b) **bound reverse-request relay** — the server opens a long-lived proxy/exec channel and treats requests arriving over it as "from sprite X, generation N", then authorizes each one by digest before touching a credential. (a) has fewer moving parts and never parses hostile request bytes; (b) is the primitive if guest code itself must trigger the request. What is *not* sound is any design in which the guest's contents — a header, a bearer, its own view of its id — are the identity.
5. **The instance id is observable and ABA-safe (§4).** *Therefore the grant can bind `sandbox instance + generation` (as the epic's grant shape already lists) so a grant replayed against a reclaimed sprite fails closed*. The instance id covers recreate; generation must be a provisioner-owned counter bumped on `restoreCheckpoint`, since the platform exposes no field that changes on restore — and because the id is not confidential (§3.2), the grant's *security* rests on the org-token channel and the digest binding, never on the id being secret.

**So the L4 posture is:** the Git relay and the CLI relay run in the server-side tool runner; they resolve the credential inside the credential plane and reach into the sandbox over the exec/session channel; the sandbox never receives, requests, or holds the credential. The raw `GH_TOKEN` injection (Λ1) is removed here, as the gate ledger already requires. This is not a compromise fallback — given a root guest it is the *simplest* arrangement that satisfies invariant 1 (reference, never value); the bound duplex channel below is the other, and it satisfies the invariant only with its caveats intact.

**Alternative for L4 — the bound duplex channel (decision deferred to G4; recorded in ADR 0006 Amendment 2026-09-15):** if G4 or a later phase needs guest-*originated* requests (the guest's own code triggering an authenticated fetch, a long-lived reverse-request relay), the caller-identity primitive is the server-opened channel of §3.4: the runner opens `proxyPort`/exec to the named sprite, verifies `getSprite(name).id` + generation at open time, and treats every request arriving over that connection as "from sprite X, generation N". The request then goes through the same digest authorization, origin pin and approval as a relay-originated one, and the credential is substituted host-side, *after* authorization — the "Sentinel" end state D-18 points at is one realization of this. Caveats, each a RED test when built: (i) the channel identifies the sprite, not a benign process — root authors every byte, so a request over it is hostile input with a trustworthy *source*, nothing more; (ii) replay/generation binding is still required — a channel must be closed on any generation bump (restore or recreate), and the binding re-checked at presentation, not only at open. The restore signal is the provisioner's own generation counter, bumped on every `restoreCheckpoint` it performs, because the platform instance id does not change on restore (§4). The counter only sees restores the provisioner performs, so G4 must make the provisioner the **exclusive restore path**: `restoreCheckpoint` is reachable only through the provisioner, and no other holder of the org token restores. Otherwise G4 must consume an independently monotonic restore event from the platform, if one exists (not observed). Re-reading the checkpoint list is **not** a fence, because the same checkpoint stays listed before and after a restore, and no observed platform field changes on restore. A restore performed out of band is **unmitigated** until one of the two holds; (iii) the identity never comes from the request contents (F4 in ADR 0006); (iv) nothing about the channel lets a private key or bearer inside the guest substitute for the gate. Relay-only remains the recommended v1 because it needs none of (i)–(iii) per request.

**What would change this recommendation:** a Sprites primitive that (a) lets the *server* inject a per-connection secret the guest process can read but that is bound to the instance and unreadable across a reclaim, *and* (b) gives guest code a channel it can **originate** to the broker, authenticated by that binding. Neither exists on `0.0.1-rc48` today: the only host-side surface the guest can reach is the read-only status socket (§3.2), and it exposes no such secret and no guest-originated back-channel. (The server-opened duplex channel above is not (b): the guest cannot open it, and its identity is the server's binding, not a guest-held secret — which is exactly why it is usable.) Re-run §3.2–3.4 before assuming any newer runtime adds one.

## 6. Reproduction

All scripts ran from a scratchpad, importing the SDK by absolute path from `apps/web/node_modules/@fly/sprites/dist/index.js` (no `node_modules` created in this worktree). To reproduce:

```sh
# 1. mint tokens — NEVER into the worktree (not gitignored, umask-dependent perms, outlives teardown).
#    Both tokens are reusable for their 2 h lifetime (`-x 2h`), so they live in a private tempdir
#    that is removed when the shell exits; the org token is also revocable with `flyctl tokens revoke`.
TOK=$(mktemp -d); umask 077; trap 'rm -rf "$TOK"' EXIT
flyctl tokens create org -o personal -x 2h > "$TOK/fly-org-token.txt"   # strip leading "FlyV1 "
TOK="$TOK" node -e 'import("<repo>/apps/web/node_modules/@fly/sprites/dist/index.js").then(async ({SpritesClient})=>{
  const fs=require("fs"), d=process.env.TOK;
  const m=fs.readFileSync(`${d}/fly-org-token.txt`,"utf8").trim().replace(/^FlyV1\s+/,"");
  fs.writeFileSync(`${d}/sprites-token.txt`, await SpritesClient.createToken(m,"personal"), {mode:0o600}); })'
#    every later step reads the Sprites token from "$TOK/sprites-token.txt"; nothing under <repo> holds it.

# 2. create two sprites (names <= 48 chars), start a header-echo server on 8080 of the origin,
#    set the origin URL auth:'public', and record the laptop baseline request.
# 3. guest phase: from inside the guest, fetch the origin URL honestly and with every identity
#    header forged; fetch httpbin + pagespace.ai; read api.ipify.org for the egress IP.
# 4. readable phase: id; sudo -n id; env; /proc/1/environ; probe /.sprite/api.sock verbs;
#    probe 169.254.169.254, [fdaa::3], api.internal, 10.0.0.1:{22,80,443,8080,9000} (own addr);
#    G4 adds (gateway, not probed in this run): full TCP connect scan 10.0.0.2:1-65535; UDP with
#    PROTOCOL-VALID requests for 53/67/68/123/161/5353 plus a full-range sweep in which only an ICMP
#    port-unreachable counts as closed; link-local 169.254.0.0/16 and IPv6 link-local/gateway equivalents.
#    Any application reply = OPEN (investigate; e.g. DNS on :53). RST / ICMP port-unreachable = closed.
#    Every unprobed port/protocol AND every silent / open|filtered / filtered result is residual,
#    never evidence of absence. ICMP replies are rate-limited, and a dropped probe is indistinguishable from filtering, so it stays RESIDUAL and is never classified as closed.
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
