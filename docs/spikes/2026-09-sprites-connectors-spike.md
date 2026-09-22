# Spike: Sprites Connectors — can one org hold many users' GitHub credentials, bound per-sprite, without the guest ever seeing a token?

> **Date:** 2026-09-18 · **SDK:** `@fly/sprites@0.0.1-rc37` (no Connectors surface — raw REST only) · **Runtime:** `0.0.1-rc48` · **API:** `https://api.sprites.dev`
> **Outcome (2026-09-18, later the same day): route DECLINED** — D-34 revised (`j471yhv7p3abea7mlxrchdu1` control board). Sprites Connectors will not be the credential plane in any form, including a custom_api-wrapped universal relay: credential-plane coupling to Fly is stickier than compute (OAuth consent accrues; tokens are non-exportable, so demotion = a per-user re-consent campaign), the gateway is physically Fly-only so the provider-agnostic relay must be built regardless, and the custom_api variant re-imports the Fly custody residuals while adding a billed, always-warm relay-sprite failure domain. This spike stands as the rejected-alternative record and exit-cost analysis. Nothing in §7 ("What this means for the board") was adopted; the board reverted to the D-18 relay-first design the same afternoon — zero code written, which is the spike-first discipline paying for itself.
> **Epic:** Agent Accounts & Credential Broker (`j471yhv7p3abea7mlxrchdu1`) · **Task:** S4 (this spike) · **Feeds:** Λ1, Λ6, D-24 custody rule, G2/G3/G4 entry, G1c shape re-review. Extends S1 (`2026-09-sprites-trusted-transport-spike.md`), whose "no trusted guest→server channel" conclusion this spike **partially revises**.
> **Why:** the Connectors API was discovered to be a multi-connection, per-provider credential store with a request-signature-authenticated gateway. If one Sprites org can hold many GitHub accounts simultaneously, each bound to disjoint sprite labels with deny-by-default, then Sprites is a viable credential plane for OAuth providers and a large part of the planned broker (Infisical for OAuth, our own refresh worker, the G4 guest-identity problem) shrinks or dies. Every prior claim rested on docs; this spike is the empirical test.
> **Method:** real org token (`flyctl tokens create org` → `SpritesClient.createToken(macaroon,'personal')`), two real GitHub accounts completing the documented OAuth flows in a human browser, four real sprites created and label-set via the raw REST API, a full label-crossing matrix executed from inside the sprites over exec, and complete teardown with deletion verified both sides (sprites: `listAllSprites("ps-s4-")` → `[]`; connections: `GET /v1/oauth/connections` → `{"connections":[]}`). Every claim is marked **verified** (observed on the wire) or **assumed** (docs only). Docs sources: `docs.sprites.dev/concepts/connectors` + `sprites.dev/api/connectors` (fetched 2026-09-18; the rc48 API reference has **no** Connectors section — Connectors docs live only in the concept guide and the newer API reference).

## TL;DR — the seven questions, answered

1. **One org holds many accounts per provider — verified.** Two GitHub accounts (`2witstudios` id 215594107, `DaisyDebate` id 196503527) completed OAuth in the same org and both appear in `GET /v1/oauth/connections?provider=github` as distinct `Connection[]` entries with their own `provider_account_id`, `provider_account_name`, and `access_policy`. No 409, no singleton enforcement, no "provider already connected" error. **Sprites Connectors is a multi-tenant credential substrate.**
2. **The OAuth flow is caller-controlled end to end — verified, with one docs-vs-wire gap.** `GET /v1/oauth/github/authorize` echoes a caller-supplied `state` verbatim (our nonce comes back untouched) and accepts a caller `redirect_uri`. **The wire does NOT bake in the documented default scopes**: with no `scopes` param the authorize_url carries `scope=` (empty) — the caller must pass `scopes=repo,read:org` explicitly or the connector gets zero scopes. And contrary to the concept doc's "on consent … the connector is created", the Sprites callback **does not auto-create the connector**: it renders the `code` plus a ready-made completion curl. The caller (PageSpace's backend) completes via `POST /v1/oauth/{provider}/callback` with `code`, `state`, and `access_policy` — **the credential is born scoped**, no create-then-lock-down window.
3. **The gateway authenticates the calling sprite from the Fly request signature — verified in both directions.** A call from a laptop (not a sprite) → `401 {"error":"authentication failed"}`. A call from inside a sprite needs **no Authorization header at all** — and no forged bearer from the guest could matter because the identity is not a header (corroborates S1 §2: edge-set attributes are guest-unforgeable; here the edge *is* the authority). This is the trusted channel S1 said did not exist: not guest→control-plane, but guest→**gateway**, with substitution at the boundary.
4. **Label-crossing fails closed — verified.** Sprite A (label `ps-s4-label-a`) got `GET /user` → `200` with `login: 2witstudios` through connection A and `403 {"error":"sprite is missing required labels: ps-s4-label-b"}` through connection B; sprite B mirrored it exactly (`DaisyDebate` / 403 on A); the control sprite with no labels got 403 on everything ("a connector with no policy refuses every Sprite" — enforced). Each sprite received **its own** GitHub identity from **its own** connection, and the guest held no token at any point.
5. **Policies match dynamically — verified.** A sprite created *after* a connection's policy existed, then labeled via `PUT /v1/sprites/{name}` (a field the SDK types don't know about; the wire accepts it on create and update), could use the connection immediately. Policy evaluation is per-request against current sprite labels — exactly what per-session sandbox provisioning needs.
6. **REST yes, git no — verified.** `GET /repos/{owner}/{repo}` through the gateway returns real repo data (200). Git smart HTTP does **not** route: `{conn}/2witstudios/PageSpace.git/info/refs?service=git-upload-pack` returns a GitHub-**REST**-shaped 404 (`docs.github.com/rest` link) — the gateway forwards to `api.github.com`, and git lives on `github.com`. Anonymous `git ls-remote https://github.com/...` from the same sprite worked (public repo). **G4's server-side Git relay survives for git transport; Connectors retires the raw `GH_TOKEN` for REST and for public-repo git.**
7. **Refresh: GitHub needs none; the gateway owns it where it exists.** `token_expires_at: null` on both GitHub connections (**verified** — GitHub OAuth tokens don't expire). The docs state the gateway auto-refreshes any provider token within five minutes of expiry (Slack et al.) (**assumed** — no expiring token was in scope). Our planned RFC 9700 refresh worker shrinks to providers Connectors doesn't hold.

---

## 1. Setup (verified)

- **Token:** `flyctl tokens create org -o personal -x 2h` → strip `FlyV1 ` → `SpritesClient.createToken(macaroon,'personal')` → `personal…` token (114 chars), same recipe as S1. All Connectors calls took this one bearer.
- **Feature flag:** the API reference notes the Connectors *dashboard* is behind a `connected_services` flag but "API access is controlled by bearer token authentication". **Verified for this org**: zero dashboard setup, `GET /v1/oauth/providers` → 200 with 11 providers (`github`, `slack`, `slack_bot`, `discourse`, `openrouter`, `meta`, `openai`, `typesafe`, `anthropic`, `s3_object_store`, `custom_api`; the enum also names `ollama` and `sprites_admin`, not exposed here — per-org rollout, per docs).
- **Sprites:** `ps-s4-sprite-a-t5qk` (label-a), `ps-s4-sprite-b-w7n9` (label-b), `ps-s4-sprite-c-n4fr` (no labels, control), `ps-s4-sprite-d-q2v8` (dynamic-match probe). Labels set by including `"labels": [...]` in the raw `POST /v1/sprites` body (echoed back in the response; `@fly/sprites@rc37` types have no labels field — wire superset, same pattern as the 2026-08 spike's `private_access`).
- **Consent flows:** two humans, two GitHub accounts, the two authorize URLs from §2. The consent screen shows Sprites' own GitHub OAuth app (client_id `Ov23lisx1GALDjNqHc2Z`) — branding is Fly's, not PageSpace's (product UX consideration, §7).
- **Exec discipline:** S1's rules held — 40 s caps, exec sockets linger, and one control-plane `503 service temporarily unavailable` on `getSprite` needed a retry loop.

## 2. The caller-controlled OAuth flow (verified)

`GET /v1/oauth/github/authorize` (bearer = org Sprites token):

| Call | Wire result |
|---|---|
| `?state=ps-s4-spike-nonce-a7f3d2` | 200 `{state: <echoed verbatim>, authorize_url: …redirect_uri=api.sprites.dev/v1/oauth/github/callback…scope=…empty…}` |
| same + `&redirect_uri=http://localhost:9999/callback` | 200 — API accepts any URI; whether GitHub honors it depends on the OAuth app's registered callbacks (not browser-tested) |
| `?scopes=repo,read:org&state=…` | 200 — `scope=repo+read%3Aorg` present in the URL |

**The scope gap is load-bearing for PageSpace:** the concept doc says default scopes are `repo` and `read:org`, but that default is **not** applied server-side to the authorize_url. A backend that calls authorize without `scopes=` gets a consent page that grants nothing. Always pass scopes explicitly.

**Completion is the caller's job.** After consent, GitHub redirected to the Sprites callback, which rendered (to the human): *"Your github authorization was successful. To complete the connection, make this API call: `POST /v1/oauth/github/callback {"code": …, "state": …}`"*. Both flows were then completed by us with a policy in the same request:

```
POST /v1/oauth/github/callback
{"code":"440e2…","state":"ps-s4-flowa-9k2m4x",
 "access_policy":{"sprite_labels":["ps-s4-label-a"]}}
→ 201 Created
```

Response (sanitized — no token field anywhere, **verified**): `id` (`kIVe_9LuZsRTBCx3M3xZDQ` — opaque, not `conn_…`-shaped as docs examples show), `provider: "github"`, `provider_account_id: "215594107"`, `provider_account_name: "2witstudios"`, `connection_type: "oauth"`, `scopes: "read:org,repo"`, `token_expires_at: null`, `user_id: null`, `provider_info: {user_id, user_name, user_avatar}`, `usage_snippet` (ready-made curl through the gateway), and the embedded `access_policy`.

- `user_id: null` (**verified**): API-completed connectors are bound to the **organization**, not to any Sprites user — org-scoped custody, exactly the shape a broker needs.
- The single-use `code` from flow A worked for at least ~10 minutes after consent (consent ~16:5x, completion 16:53:58Z) (**verified** once; expiry window not measured precisely).

## 3. Gateway identity and the label-crossing matrix (verified)

`https://api.sprites.dev/v1/gateway/github/<connection_id>/<path>`, no auth header, called from inside the sprites over exec (`curl`):

| Caller → connection | Path | Result |
|---|---|---|
| sprite A (label-a) → conn A | `/user` | **200** `{"login":"2witstudios","id":215594107,…}` |
| sprite A → conn B | `/user` | **403** `{"error":"sprite is missing required labels: ps-s4-label-b"}` |
| sprite B (label-b) → conn B | `/user` | **200** `{"login":"DaisyDebate","id":196503527,…}` |
| sprite B → conn A | `/user` | **403** `missing required labels: ps-s4-label-a` |
| sprite C (no labels) → conn A | `/user` | **403** `missing required labels: ps-s4-label-a` |
| **laptop** → conn A | `/user` | **401** `{"error":"authentication failed"}` |

Reading: the credential substitution happens inside the Sprites gateway after a Fly-signature identity check and a policy check, per request. The two sprites talked to two *different* GitHub accounts; neither sprite could reach the other's credential; the guest never held, saw, or transmitted a token (nothing to hold — the API returns sanitized connections only, **verified** in every response). The 403 message names the missing labels — a mild information leak about policy shape to an unauthorized caller, acceptable inside an org.

`POST /v1/oauth/connections/{id}/test_gateway` (server-side policy probe, the dashboard's Test button): conn A × sprite A → `{"status":"ok","message":"Authenticated as @2witstudios","latency_ms":429}`; conn A × sprite B → `{"status":"error","message":"HTTP 403 …missing required labels…"}` (**verified** — gives PageSpace a server-side health/policy check without exec).

`GET /v1/gateway/list` from inside sprite A (**verified**): returns `available` providers (with default scopes) and — for authorized connections — `connections` entries carrying `gateway_base_url` (connection id baked in), display name, description, scopes, usage snippet. This is the in-guest discovery surface an agent uses with no secrets attached.

## 4. Policy semantics on the wire (verified)

- **Dynamic matching:** sprite D was created *after* conn A's policy existed, labeled via `PUT /v1/sprites/ps-s4-sprite-d-q2v8` with `{"labels":["ps-s4-label-a"]}`, and its first gateway call → **200**. No policy re-save, no propagation window observed. Per-request evaluation.
- **Exact vs wildcard paths:** with `allowed_endpoints: ["/user", "/repos/*"]` — `/user` → 200; `/user/repos` → **403** (the exact pattern `/user` does *not* prefix-match `/user/repos`; patterns are exact-path or trailing-`*` only); `/orgs/…/members` → 403 (not listed). **PageSpace must enumerate both a path and its children.**
- **Mid-string globs don't block:** `blocked_endpoints: ["/repos/*/forks"]` did **not** block `/repos/2witstudios/PageSpace/forks` (→ **200**), consistent with the documented "no mid-string globbing". The API accepts the pattern and it just never matches. A deny-list built on `*`-in-the-middle patterns silently doesn't protect anything — guard-test material for G2.

## 5. What the gateway cannot do (verified)

- **Git smart HTTP does not route.** `/2witstudios/PageSpace.git/info/refs?service=git-upload-pack` → GitHub-**REST** 404 (`{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}`): the github provider's upstream base is `api.github.com`; git's HTTP protocol lives on `github.com`. `git ls-remote` through the gateway fails; the same sprite's anonymous `git ls-remote https://github.com/2witstudios/PageSpace.git` succeeded (public repo). Connectors today cover **REST** GitHub operations (issues, PRs, contents, checks) — not clone/push/pull, and not `gh` CLI flows that need git transport.
- **No human-approval hook.** The policy is allow/deny by labels/prefix/paths — there is no allow-once / ask-on-write / approval-digest concept anywhere in the Connectors surface (docs + wire). Epic invariant 4 (approval bound to a canonical request digest) stays a **PageSpace-side** mechanism: our own gate decides whether the sprite is allowed to issue the gateway call at all.
- **No credential read-back.** No endpoint returns the stored token; completion responses, list, get are all sanitized (**verified** for list/get/completion). Deleting a connection destroys the credential (204; **verified** in teardown).

## 6. Custody assessment (feeds D-24)

- **What Sprites holds at rest:** the encrypted provider token in the org's Sprites database. Never returned by any API (**verified**). Rotation of OAuth = re-consent; of BYOK = `PUT …/api_key` (docs).
- **Who can use:** any process inside a sprite whose Fly identity matches the connection's policy. Not reproducible from laptops/CI (**verified** 401), not from the PageSpace server process either — **our server cannot call the gateway**, only manage connections.
- **Blast radius of org-token compromise:** full connector **use** — create a sprite, label it, PATCH the policy to grant it — but **not credential exfiltration** (no read-back). This is a use-hijack liability, strictly smaller than the current `GH_TOKEN` env-var liability (Λ1), which is outright theft. Note the PageSpace web process already holds exactly this class of token (`SPRITES_API_TOKEN`) for sandbox management, so Connectors adds no *new* token class to custody — it reuses the one we already defend.
- **Onprem:** Connectors are a Fly-hosted service; an onprem PageSpace deployment cannot use them. The Infisical plane (G1b-store, already merged) remains the onprem credential plane. **Infisical's scope shrinks; it does not die** (also still needed for `api_key`/`password`/`session` kinds against arbitrary origins).
- **Consent branding:** users consent to *Fly/Sprites'* GitHub OAuth app (client_id `Ov23lisx1GALDjNqHc2Z`, **verified** in the authorize_url), not a PageSpace-owned app. Product decision pending: acceptable ("sprites connect to your GitHub") vs needing our own OAuth app (which Connectors does not support — the client is Sprites').

## 7. What this means for the board

1. **S1's operative conclusion is revised, not overturned.** S1: "no guest-originated trusted channel; G4 = server-side runner originates every credentialed op." The gateway is a *third* thing S1's taxonomy didn't contain: guest-originated **network** requests are unforgeable *at the gateway boundary*, because the substitution point is the Sprites edge itself. In-guest credentialed REST is now safe **without** any broker grant/presenter key reaching the guest — the guest only ever knows a connection id and a URL.
2. **G4 becomes a split design:** REST credentialed ops → in-guest via gateway (connection ids resolved from PageSpace references at provision time); git transport → the planned server-side relay, unchanged, because the gateway cannot carry git. Λ1 (raw `GH_TOKEN` env var) is retired **now** for REST + public-repo git; the token's remaining git use for private repos lives until the relay ships (D-25 status quo continues, now with a much smaller surface: git-only).
3. **G2 (one custodian, scoped) keeps its shape but changes its backing for OAuth:** the `oauth2` account kind becomes a thin reference row (provider, connection id, gateway base) + PageSpace-side permission semantics; the credential plane for those rows is Sprites, not Infisical. The api_key thin slice proceeds as planned (BYOK providers `openai`/`anthropic`/`openrouter`/… are *also* Connectors candidates — one `POST /v1/oauth/connections/api_key` replaces our stored-key path for those origins; the residual for Infisical is arbitrary-origin custom APIs, passwords, sessions).
4. **G3 (migrate liabilities, refresh worker) shrinks hard:** GitHub connectors need no refresh (no expiry, **verified**); Slack-class expiry is the gateway's job (docs). The RFC 9700 worker remains only for providers neither Sprites nor we host — scope it during G3 planning.
5. **G1c (shape review) must fold in:** frozen `oauth2` shape maps to (provider, connection_id, access_policy) with `allowed_endpoints`/`blocked_endpoints` as the origin+operation-pinning story; the no-mid-string-glob rule and exact-vs-prefix path semantics become part of the restriction grammar; approval (invariant 4) stays ours; a guard test must ban mid-string glob patterns in anything we generate.
6. **Product/UX decisions this forces (for the Point Guard channel):** consent branding (Fly's app, §6); completion UX (default Sprites callback renders the code for our backend to complete — or ask Fly for a registered PageSpace `redirect_uri`); per-user isolation is by **label discipline** (`ps-user-<hash>`), so sprite provisioning must set labels atomically and the permission layer must treat label→connection binding as a managed decision (invariant 5).

## 8. Open questions (none block the board edits)

1. Will Fly register a per-org OAuth callback (`redirect_uri`) so the completion code lands on PageSpace's backend directly instead of the copy-the-code page? (Requested via Point Guard; the current flow works without it.)
2. Gateway rate limits / quotas per connection — undocumented; observed no limits in this spike's volume.
3. Scoped (non-unrestricted) Sprites tokens vs the Connectors CRUD API — docs say balance/usage endpoints 403 for scoped tokens; whether connection CRUD accepts scoped tokens is untested. Until tested, assume the web-process token is full-authority (§6 blast radius).
4. Refresh behavior observed only for non-expiring tokens; the 5-min-before-expiry refresh claim remains docs-verified only.

## Appendix: raw evidence

Scratch scripts and token lived in the session scratchpad (`/tmp/opencode/s4/`, token 0600, deleted with the scratchpad). Sprites created: a-t5qk 16:55:23Z, b-w7n9, c-n4fr, d-q2v8; all deleted 17:03:53–17:04:17Z (31 s teardown window), `listAllSprites("ps-s4-")` → `[]`. Connections: conn A `kIVe_9LuZsRTBCx3M3xZDQ` inserted 2026-09-18T16:53:58.318Z, conn B `uWrelixHQ9op2uLNx4Xidw` inserted 16:53:59.160Z; both `DELETE` → 204, `GET /v1/oauth/connections` → `{"connections":[]}`. Key raw shapes:

```jsonc
// POST /v1/sprites {"name":"ps-s4-sprite-a-t5qk","labels":["ps-s4-label-a"]} → 201
{ "id": "sprite-70f377d7-…", "labels": ["ps-s4-label-a"], "status": "cold",
  "url": "https://ps-s4-sprite-a-t5qk-bskrl.sprites.app", "organization": "2wits", … }

// POST /v1/oauth/github/callback (code+state+policy) → 201
{ "connection": { "id": "kIVe_9LuZsRTBCx3M3xZDQ", "provider": "github",
  "provider_account_id": "215594107", "provider_account_name": "2witstudios",
  "connection_type": "oauth", "scopes": "read:org,repo", "token_expires_at": null,
  "user_id": null, "access_policy": { "sprite_labels": ["ps-s4-label-a"] },
  "usage_snippet": "curl https://api.sprites.dev/v1/gateway/github/kIVe_…/user" } }

// in-guest: curl https://api.sprites.dev/v1/gateway/github/<connA>/user
{"login":"2witstudios","id":215594107,…}          // sprite A → 200
{"error":"sprite is missing required labels: ps-s4-label-b"}  // sprite A → connB: 403

// laptop: curl https://api.sprites.dev/v1/gateway/github/<connA>/user
{"error":"authentication failed"}                  // 401

// git through the gateway (sprite A):
// GET <gateway>/2witstudios/PageSpace.git/info/refs?service=git-upload-pack →
{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}
// same sprite, anonymous, github.com directly:
// git ls-remote → 7521f00711b1605b2db863e954112661209e4759	HEAD
```
