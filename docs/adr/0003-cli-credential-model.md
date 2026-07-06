# ADR 0003 — CLI Credential Model

- **Status:** Proposed (Phase 0 contract — freezes the credential model Phases 1 and 4 implement)
- **Date:** 2026-07-03
- **Deciders:** SDK/CLI/OAuth epic (epic page `ea07mt5jvw0flihsbjce1iv9`, Phase 0 task `jttts1iz2fdp2bna3kph6hq5`)
- **Related:** the API versioning ADR and the OAuth scope grammar & client model ADR (Phase 0 siblings). Scope *semantics* (grammar, drive-scope mapping) are owned by the scope-grammar ADR; this ADR only fixes which credential carries them.

## Question

What token does the CLI actually hold after `pagespace login`? Two live candidates:

- **(a)** OAuth 2.1 access + refresh tokens, issued by the Phase 1 authorization server, accepted as a new token type through `authenticateRequest`.
- **(b)** Reuse of the existing device-token machinery (`ps_dev_*`, 90-day, rotation, refresh route already shipped for Electron/mobile).

## Decision (summary)

**Option (a). OAuth 2.1 tokens ARE the CLI credential.** `pagespace login` (authorization-code + PKCE, or the device-authorization grant for headless boxes) yields an opaque **access token (`ps_at_*`, 15 minutes)** plus an opaque **rotating refresh token (`ps_rt_*`, 30-day per-token TTL, 90-day absolute family cap, family revocation on reuse)**. Device tokens are **not** extended to the CLI. Scoped `mcp_*` tokens remain the non-interactive credential for agents/CI, minted trivially via `pagespace tokens create`. CLI auth precedence is fixed as `--token` flag > `PAGESPACE_TOKEN` env > stored profile.

Everything below is the verified evidence and the precise, testable contract.

---

## 1. Code spike — device-token machinery, verified

All claims carry `file:line` citations from this monorepo (branch `pu/cli-login` lineage) or `/Users/jono/production/pagespace-mcp`.

### 1.1 What a device token is

- Opaque `ps_dev_*` token, 32 bytes base64url entropy, no embedded claims (`packages/lib/src/auth/opaque-tokens.ts:17-26`); SHA3-256 hashed at rest, hash-only lookup, no plaintext fallback (`packages/lib/src/auth/device-auth-utils.ts:59-60,152-160`; `packages/lib/src/auth/token-utils.ts:42-44`).
- DB row carries `deviceId`, `platform`, `tokenVersion`, IP/user-agent tracking, `trustScore`, `suspiciousActivityCount`, `replacedByTokenId` (`packages/db/src/schema/auth.ts:56-99`).
- Lifetimes: `TOKEN_LIFETIMES = { ACCESS_TOKEN: '15m', REFRESH_TOKEN_DEFAULT: '7d', REFRESH_TOKEN_REMEMBERED: '30d', DEVICE_TOKEN: '90d' }` (`packages/lib/src/auth/device-auth-utils.ts:13-18`); 90-day expiry set at creation (`device-auth-utils.ts:56-57`).

### 1.2 Trust-score / fingerprint / IP machinery is **vestigial (display-only)**

- `validateDeviceFingerprint`, `calculateTrustScore`, `isRapidRefresh`, `isSameSubnet` are defined in `packages/lib/src/auth/device-fingerprint-utils.ts:123-226` — and **no production route calls any of them**. A repo-wide grep finds only their definitions and tests; the sole non-test consumers of the columns are: creation writing constants (`trustScore: 1.0`, `suspiciousActivityCount: 0`, `device-auth-utils.ts:76-77`) and the devices UI reading them back for display (`apps/web/src/app/api/account/devices/route.ts:22,56`; `apps/web/src/hooks/useDevices.ts:13`).
- IP is tracked (`lastIpAddress` updated on activity, `device-auth-utils.ts:201-219`; refresh route passes it through, `apps/web/src/app/api/auth/device/refresh/route.ts:141-143`) but **never enforced**. IP churn (ssh boxes, CI egress, laptops roaming) has zero authentication effect today.
- **Consequence for the CLI:** the machinery is harmless *today*, but its schema presence means any future activation of trust-score enforcement (built for browsers/mobile: user-agent families, subnet heuristics — `device-fingerprint-utils.ts:12-45,197-213`) would silently degrade CLI auth, which has no meaningful user-agent and legitimate IP churn. Building the CLI on this table couples it to a risk model designed for a different client class.

### 1.3 What IS enforced: strict device binding — wrong shape for CLI patterns

- Refresh requires the client to present the exact stored `deviceId`; missing/`'unknown'`/mismatched → hard 401, forced re-auth, no rebind (`packages/lib/src/auth/token-lifecycle-policy.ts:55-75`; `apps/web/src/app/api/auth/device/refresh/route.ts:67-93`).
- Ephemeral CI containers get a fresh `deviceId` every run → every run is a full login minting a new row (the partial unique index `(userId, deviceId, platform) WHERE revokedAt IS NULL`, `packages/db/src/schema/auth.ts:95-97`, dedupes per-device, not per-user) → unbounded row growth and a devices UI full of dead "devices". Device tokens are structurally wrong for CI. (CI belongs on `mcp_*` tokens — §4.)
- `platform` is a Postgres enum `('web','desktop','ios','android')` (`packages/db/src/schema/auth.ts:8,68`), baked into function signatures across the stack (`device-auth-utils.ts:43,98,267,418`; `token-lifecycle-policy.ts:20`). Adopting device tokens for the CLI means either lying about platform or an enum migration plus signature sweep.

### 1.4 Device-token rotation exists but lacks reuse detection

- Rotation: on refresh, when <60 days of the 90-day lifetime remain, the token is atomically rotated (FOR UPDATE, old revoked, new linked via `replacedByTokenId`) (`apps/web/src/app/api/auth/device/refresh/route.ts:101-139`; `packages/db/src/transactions/auth-transactions.ts:55-62`).
- A 30-second grace window lets a *second* concurrent request that hits the already-rotated old token succeed instead of hard-failing — but it does **not** hand that caller a usable token. `atomicDeviceTokenRotation`'s grace branch returns only the replacement's id/metadata (`deviceTokenId`, `deviceName`, `userAgent`, `location`), never `newToken` (`auth-transactions.ts:147-174`, comment at :164-166: *"client already has it from the first request"*); the refresh route only overwrites `activeDeviceToken` when `rotated.newToken` is truthy (`route.ts:135-137`), so a grace replay echoes back the **stale, already-revoked** token. This narrowly covers true double-fire races (client fires two requests near-simultaneously, both land inside the same 30s window) where the *first* request's response is assumed to still be in flight and will deliver the real token. It does **not** recover a caller whose first response was genuinely lost (dropped connection, client crash mid-response) — that caller is left holding a dead token with no path back except full re-auth.
- **After the grace window** (or for a genuinely lost-response caller within it), presenting a rotated-away token is a silent 401 — the replacement token stays valid and nothing is revoked. There is no token *family* concept (single `replacedByTokenId` hop only) and no theft alarm. Both the missing-recovery-path and the missing-theft-alarm are below the bar this epic sets for a fresh credential; §3.4 does not inherit either gap.

### 1.5 What refresh actually yields: full-scope sessions

- A device refresh mints a session with `scopes: ['*']` — 7 days for web, **90 days** for desktop/mobile (`apps/web/src/app/api/auth/device/refresh/route.ts:168-176,198-206`).
- `deviceTokens` has **no scopes column at all** (`packages/db/src/schema/auth.ts:56-99`). Making device tokens scope-aware from day one — an epic requirement (epic page line 15: CLI and `mcp_*` both authenticate through `authenticateRequest`; scope-grammar ADR maps scopes onto drive capabilities) — means schema surgery on a table five platforms already depend on.

### 1.6 Sessions are also the wrong vehicle

Considered and rejected as a sub-variant of (b): "login just mints a long `ps_sess_*` session".

- `validateSession` enforces an idle timeout that **defaults to 15 minutes on-prem** (0/disabled on cloud) and *revokes* the session on idle (`packages/lib/src/auth/constants.ts:20-37`; `packages/lib/src/auth/session-service.ts:101-109`). A CLI a developer runs a few times a day would be silently logged out between invocations on every on-prem install.
- Sessions carry cookie/CSRF semantics (`apps/web/src/lib/auth/index.ts:309-333`) irrelevant to a Bearer-only client, and long-lived bearer access tokens violate the epic's zero-trust posture outright (task spec: "no long-lived bearer access tokens").

### 1.7 Existing machinery the OAuth path builds on (reuse, not reinvent)

- Opaque token generator + format gate: `ps_{type}_` + 32-byte base64url; the regex allowlist currently admits `sess|svc|mcp|dev` and must be extended (`packages/lib/src/auth/opaque-tokens.ts:10,17-26,28-33`).
- SHA3-256 hash-at-rest utilities (`packages/lib/src/auth/token-utils.ts:42-59`).
- Distributed fixed-window-with-smoothing rate limiting; `REFRESH` bucket = 10 attempts / 5 min / 5 min block, keyed per IP (`packages/lib/src/security/distributed-rate-limit.ts:497-515`; applied in `apps/web/src/app/api/auth/device/refresh/route.ts:40-60`).
- One-time-use atomic `DELETE … RETURNING` consumption pattern for codes (`packages/lib/src/auth/exchange-codes.ts:96-123`) — the model for authorization-code and device-grant code consumption.
- **Caution:** the existing `packages/lib/src/auth/pkce.ts` is PageSpace acting as an OAuth *client* (Google login) and is **fail-open by design** ("if the DB is unavailable … the OAuth flow still works", `pkce.ts:9-11,65-70`). The Phase 1 *provider-side* PKCE verifier is new code and MUST be fail-closed (§5). Do not repurpose this module.
- Pure-decision-module precedent to follow: `packages/lib/src/auth/token-lifecycle-policy.ts:1-18` (no-I/O policy functions behind thin route shells).
- `authenticateRequestWithOptions` dispatches on token prefix with an explicit allow-list and rejects unknown Bearer formats (`apps/web/src/lib/auth/index.ts:15,49-53,265-303,384-394`) — the extension point for the new token type.
- Legacy consumer being replaced: `pagespace-mcp` reads `PAGESPACE_AUTH_TOKEN` from env and sends it as a Bearer header (`/Users/jono/production/pagespace-mcp/src/config.js:17,20-21`, `src/api.js:53,95`).

---

## 2. Decision D1 — OAuth tokens are the CLI credential

`pagespace login` runs authorization-code + PKCE (browser available) or the device-authorization grant (headless) against the Phase 1 provider, and the tokens those grants issue are **the** credential the CLI stores and presents. No exchange into a device token.

**Why (each reason grounded in §1):**

1. **One issuance model.** Phase 1 builds OAuth grants regardless (epic architecture, decided). Exchanging OAuth tokens into device tokens would mean two lifecycles, two revocation models, and two audit trails for one login.
2. **Scope-aware from day one.** OAuth tokens carry scopes at issuance; device tokens have no scopes column (§1.5) and refresh into `['*']` sessions today (§1.5).
3. **No device-model impedance.** No `platform` enum lie/migration (§1.3), no strict `deviceId` binding that CI/ssh patterns violate (§1.3), no coupling to vestigial browser-shaped trust scoring (§1.2).
4. **Strictly better rotation.** The new refresh family gets reuse detection + family revocation, which device tokens lack (§1.4).
5. **Sessions disqualified** by on-prem idle revocation and cookie/CSRF semantics (§1.6).

The `client_id` for the first-party CLI, redirect-URI rules for the loopback callback, and the consent screen are owned by the OAuth scope grammar & client model ADR; nothing here constrains them beyond: tokens are bound to `(userId, clientId, scopes)` at issuance.

## 3. Decision D2 — Token format, lifetimes, rotation (the exact contract)

**F1 (post-review amendment) — refresh issuance is gated on `offline_access`.**
A refresh token (`ps_rt_*`) is minted — at initial issuance (`authorization_code`
or `device_code` grant) or at rotation (`refresh_token` grant) — **only** when
the granted scope set includes the `offline_access` scope (OIDC-standard); a
grant without it is access-token-only, and the token response omits
`refresh_token` entirely rather than sending a token nobody asked to keep
alive. `pagespace login` always requests `account offline_access`
(`packages/cli/src/commands/login.ts` `DEFAULT_LOGIN_SCOPE`), so the CLI's
normal login flow is unaffected and always receives a refresh token. A client
that narrows scope on a `refresh_token` grant (RFC 6749 §6) to drop
`offline_access` gets one final access-only pair and ends the refresh chain —
the presented token is still consumed (rotation semantics), but there is
nothing left to rotate into on a subsequent call.

**F1a (Phase 9 amendment, 2026-07-06) — `DEFAULT_LOGIN_SCOPE` is now
`manage_keys offline_access`, not `account offline_access`.** `pagespace
login` no longer requests the `account` scope by default; it requests
`manage_keys` (ADR 0002's key-management-only scope, added by Phase 9) —
still combined with `offline_access`, so the refresh-issuance gate above is
unaffected and login still always receives a refresh token. The consequence
this ADR's F1 didn't anticipate: a fresh `pagespace login` now grants zero
content access on its own. Getting an `account` or `drive:*` grant requires a
separate, explicit step — `pagespace keys` (guided) or `pagespace tokens
create` (flag-driven) — each going through its own browser consent screen.
This is additive, not a correction of D2's contract: `manage_keys` is simply
the scope `pagespace login` now requests by default, and everything else in
§3 (lifetimes, rotation, reuse detection) applies identically regardless of
which access scope a token carries. Existing stored credentials from before
this change (`account offline_access`) are unaffected and keep working as
issued — this only changes what a *new* `pagespace login` requests going
forward.

### 3.1 Format and storage at rest (server)

- Access token: **`ps_at_*`**; refresh token: **`ps_rt_*`**. Both opaque, 32 bytes base64url entropy via `generateOpaqueToken` — `TokenType` union and the `isValidTokenFormat` regex are extended with `at|rt` (`packages/lib/src/auth/opaque-tokens.ts:10,32`). No JWTs, no embedded claims — all context (user, client, scopes, family, expiry) lives in DB rows keyed by SHA3-256 hash (`token-utils.ts:42-44`), plaintext never stored, raw value returned exactly once at issuance. `tokenPrefix` (first 12 chars) stored for debugging only (`token-utils.ts:47-59`).
- Server-side rows live in new Phase 1 tables (shape is Phase 1's job); required columns are implied by §3.2–§3.4: per-token `expiresAt`, `familyId`, `familyExpiresAt`, `replacedByTokenId`, `revokedAt`/`revokedReason`, `clientId`, `scopes`, `userId`, `tokenVersion` snapshot.
- Validation of `ps_at_*` follows the session/device precedent: format gate → hash lookup → not revoked → not expired → user not suspended (suspension revokes, sticky, as `apps/web/src/lib/auth/index.ts:105-122`) → `tokenVersion` matches the user's current (as `device-auth-utils.ts:166-189`), so "logout all devices" kills CLI credentials too.

### 3.2 Lifetimes (frozen numbers)

| Parameter | Value | Anchor |
|---|---|---|
| Access token TTL | **15 minutes** | existing `ACCESS_TOKEN: '15m'` convention, `device-auth-utils.ts:14` |
| Refresh token per-token TTL | **30 days** (each rotation issues a fresh 30-day token) | `REFRESH_TOKEN_REMEMBERED: '30d'`, `device-auth-utils.ts:16` |
| Refresh family absolute cap | **90 days** from initial grant; refresh past cap → full re-login | `DEVICE_TOKEN: '90d'`, `device-auth-utils.ts:17` |
| Concurrent-refresh grace window | **30 seconds**, returns the *actual* replacement token pair (not just a success signal — see §3.4), does not extend any TTL | device-token precedent for the window duration, `auth-transactions.ts:24`; token delivery deliberately improves on that precedent (§1.4) |
| Client proactive-refresh skew buffer | **60 seconds** (treat access token as expired when ≤60s remain) | new; absorbs clock skew + request latency |

An idle CLI therefore stays logged in for up to 30 days between uses, and even a daily-active CLI re-authenticates at least every 90 days.

### 3.3 Rotation policy

Refresh tokens are **single-use and rotate on every `/token` refresh call**: each successful refresh atomically (FOR UPDATE, per `auth-transactions.ts:55-62` precedent) revokes the presented `ps_rt_*`, links it via `replacedByTokenId`, and issues a new `ps_at_*` + `ps_rt_*` pair in the same family. `familyExpiresAt` is fixed at first issuance and never extended.

### 3.4 Reuse detection, family revocation, and grace replay

Presenting a refresh token that is revoked/rotated-away and **outside** the 30-second grace window is treated as theft evidence: the **entire family is revoked immediately** (every descendant refresh token and every access token issued from the family), the event is security-logged, and the response is a constant-shape 401.

**Within** the grace window, the CLI must actually recover — inheriting the device-token precedent's "the first caller already has it" assumption (§1.4) is not acceptable here, since a dropped connection on the CLI's first response is exactly the case a developer will hit on a flaky ssh/CI network. Rotation therefore writes the new plaintext `ps_at_*`/`ps_rt_*` pair to a **short-lived, single-purpose grace cache** (e.g. Redis), keyed by the *old* token's hash, TTL = 30s, in addition to the permanent hash-only DB row. A grace-window replay looks up that cache by the presented (old, now-revoked) token's hash and returns the cached pair verbatim; the cache entry outlives the window only long enough to expire on its own (no delete-on-first-read, since a second dropped response must also be recoverable). This is a narrow, explicit, time-boxed exception to "plaintext never stored at rest" (§3.1): it lives only in the ephemeral cache, never the primary token table, and is unreachable after 30s or after the family is otherwise revoked.

If the grace window is open by DB timestamp (`revokedAt` within 30s, `replacedByTokenId` set) but the cache entry is **missing** — e.g. cache eviction, cache-tier restart — that is an infrastructure gap, not attacker behavior: the family is **not** revoked, but the caller cannot be handed a token either. This is `grace_cache_miss` (§6): a distinct, non-punitive failure the CLI maps to `reauth`, never to `purge-and-reauth`'s implicit "your credential was rejected as invalid" framing (F2).

### 3.5 Client-side storage (contract for Phase 4's credential store)

- Credentials persist in the CLI profile store as a file created with mode **0600**, parent directory 0700; every write is **atomic** (write temp + rename) so a crash mid-rotation never leaves a corrupt/partial store.
- Persist-before-use ordering: after a refresh response, the new pair MUST be durably written **before** the new access token is first used. If persisting fails, the CLI discards the in-memory pair and treats the credential as lost (the 30s grace window is a race cushion, not a durability substitute).
- Plaintext tokens never appear in logs, error messages, or shell history (`pagespace login` never accepts a token as a positional argument; `--token` is documented for scoped `mcp_*` use).
- OS-keychain integration (Electron uses `safeStorage`, `apps/desktop/src/main/auth-storage.ts:1,40`) is an acceptable Phase 4 *enhancement* behind the same store interface, but the 0600-file contract is the portable baseline (ssh boxes and containers have no keychain).

## 4. Decision D3 — Non-interactive credential and precedence

- **Scoped `mcp_*` tokens are reaffirmed as the non-interactive credential** for agents/CI/scripts: hand-mintable today (`apps/web/src/app/api/auth/mcp-tokens/route.ts:100-111`), drive-scoped with fail-closed scoped-but-empty semantics (`apps/web/src/lib/auth/index.ts:129-135`), suspension-sticky (`index.ts:105-122`), and enforced through `principal-permissions` (epic ground truth). The CLI makes minting trivial: `pagespace tokens create`. CI jobs set `PAGESPACE_TOKEN=mcp_…` — no device rows, no refresh dance, no browser.
- **Precedence order (fixed contract Phase 4 implements):**
  1. `--token <value>` flag
  2. `PAGESPACE_TOKEN` environment variable
  3. Stored profile (the OAuth credential from `pagespace login`)
- Resolution rules: first source **present** wins — presence means non-empty after trim; an empty/whitespace value is *absent* (fall through), never "authenticated as nobody". A `--token`/env credential is used exactly as given: never refreshed, never written to the profile store. If the winning source's token is invalid, authentication **fails with that source named** — the CLI MUST NOT silently fall through to a lower-precedence source (that would make "which identity am I?" nondeterministic in CI).
- The legacy `PAGESPACE_AUTH_TOKEN` env var (`pagespace-mcp/src/config.js:17`) is **not** part of the precedence contract. Whether the `pagespace-mcp` compatibility bin reads it (with a deprecation warning) is a Phase 6 migration decision; the `pagespace` CLI proper recognizes only the three sources above.

## 5. Fail-closed postures (zero-trust ledger)

Every decision above, restated as its failure behavior:

| # | Surface | On failure/ambiguity |
|---|---|---|
| F1 | Access-token validation (format, hash lookup, expiry, revocation, `tokenVersion`, suspension) | 401, constant shape; no partial identity |
| F2 | Refresh with revoked token outside grace window | Revoke entire family, security-log, 401 |
| F2a | Refresh with revoked token *inside* grace window but the grace-cache entry is missing (`grace_cache_miss`) | 401 distinct from F2: family is NOT revoked (not attacker behavior), CLI treats as `reauth`, not `purge-and-reauth` |
| F3 | Refresh past `familyExpiresAt` or per-token `expiresAt` | 401; CLI purges stored credential and requires `pagespace login` |
| F4 | Refresh network failure / 5xx / 429 rate-limited | Bounded retry with backoff (honor `Retry-After` on 429, F11); access token is NOT used past its expiry while retrying; surfaced as auth error, never a silent unauthenticated call; credential is NEVER purged for a transient failure |
| F5 | Refresh 4xx that is a definitive rejection (400 invalid_grant/invalid_request, 401 invalid_client/invalid_token) | Purge stored credential, require re-login; no retry loop. **429 is explicitly excluded from this bucket** — see F4 |
| F6 | Client persist-after-rotation failure | Discard in-memory pair, credential treated as lost (re-login) |
| F7 | Provider-side PKCE (Phase 1) | Missing/mismatched `code_verifier` → grant refused. Fail-closed, unlike the fail-open client-side `pkce.ts:9-11` which MUST NOT be reused for the provider |
| F8 | Scoped token with zero live scope targets | Deny all (existing precedent `index.ts:129-135`) |
| F9 | Unknown `ps_*`/Bearer prefix at `authenticateRequest` | Reject (existing precedent `index.ts:384-394`); `at`/`rt` added to the allowlist regex explicitly, `ps_rt_*` is NEVER accepted as an API credential (refresh endpoint only) |
| F10 | Credential precedence: winning source invalid | Error naming the source; no fallthrough |
| F11 | Rate limiting on `/token` (all grants) | 429 with `Retry-After`, per-IP distributed buckets at least as strict as `REFRESH` (10 / 5 min / 5 min block, `distributed-rate-limit.ts:510-515`) |

## 6. Pure-function signatures (Phase 1/4 implement behind thin shells)

Following the `token-lifecycle-policy.ts` precedent — no I/O, `(state, now)` in, decision out:

```ts
// packages/lib/src/auth/oauth/credential-policy.ts (Phase 1)

export interface RefreshTokenRecord {
  familyId: string;
  expiresAt: Date;          // per-token (30d)
  familyExpiresAt: Date;    // absolute cap (90d)
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  tokenVersion: number;
}

export type RefreshDecision =
  | { ok: true; action: 'rotate' }
  | { ok: true; action: 'grace-replay' } // caller fulfills from the ephemeral grace cache (§3.4)
  | { ok: false; reason: 'expired' | 'family_expired' | 'version_mismatch'; revokeFamily: false }
  | { ok: false; reason: 'grace_cache_miss'; revokeFamily: false } // in-window but cache lost the pair — infra gap, not theft
  | { ok: false; reason: 'reuse_detected'; revokeFamily: true };

export function decideRefresh(
  record: RefreshTokenRecord,
  userTokenVersion: number,
  now: Date,
  graceWindowMs: number, // 30_000
  // Fact supplied by the impure shell (it already did the Redis GET before calling in —
  // this function stays pure by taking the *result* of that I/O, not performing it).
  graceCacheHit: boolean,
): RefreshDecision;

export function issuedTokenLifetimes(
  now: Date,
  familyExpiresAt: Date,
): { accessExpiresAt: Date; refreshExpiresAt: Date }; // min(now+30d, familyExpiresAt); access = now+15m
```

```ts
// packages/cli (Phase 4)

export type CredentialSource =
  | { kind: 'flag' | 'env'; token: string }          // static; never refreshed/stored
  | { kind: 'profile'; credential: StoredCredential }
  | { kind: 'none' };

export function resolveCredentialSource(
  flagToken: string | undefined,
  envToken: string | undefined,
  profile: StoredCredential | null,
): CredentialSource; // trim; empty = absent; no fallthrough past a present source

export interface StoredCredential {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyExpiresAt: Date;
}

export type AccessDecision =
  | { action: 'use'; token: string }
  | { action: 'refresh' }
  | { action: 'reauth'; reason: 'refresh_expired' | 'family_expired' | 'no_credential' };

export function decideAccess(
  credential: StoredCredential | null,
  now: Date,
  skewMs: number, // 60_000
): AccessDecision;

export function classifyRefreshFailure(
  outcome: { kind: 'http'; status: number } | { kind: 'network' },
): 'retryable' | 'purge-and-reauth';
// network → retryable; 429 → retryable (F11 rate limit, NOT a credential judgment — never purge);
// 5xx → retryable; remaining 4xx (400/401/403 — definitive rejection) → purge-and-reauth.
// Reference body:
//   if (outcome.kind === 'network') return 'retryable';
//   if (outcome.status === 429 || outcome.status >= 500) return 'retryable';
//   return 'purge-and-reauth';
```

## 7. Testable assertions (each becomes a RED test in Phase 1/4)

1. `decideAccess(cred, now)` returns `use` iff `now + 60s < accessExpiresAt`; exactly 60s remaining → `refresh`.
2. `decideAccess` with expired access + valid refresh → `refresh`; with `refreshExpiresAt` past → `reauth('refresh_expired')`; with `familyExpiresAt` past → `reauth('family_expired')`; with `null` → `reauth('no_credential')`.
3. `decideRefresh` on a revoked token 29s after revocation with a `replacedByTokenId` and `graceCacheHit: true` → `grace-replay`; same inputs with `graceCacheHit: false` → `{ reason: 'grace_cache_miss', revokeFamily: false }` (not theft); 31s after revocation (outside window) regardless of `graceCacheHit` → `{ reason: 'reuse_detected', revokeFamily: true }`.
4. After family revocation, an access token issued earlier from that family fails validation (401).
5. `issuedTokenLifetimes` never returns `refreshExpiresAt > familyExpiresAt` (cap clamps), and always returns `accessExpiresAt = now + 15m`.
6. `decideRefresh` with `record.tokenVersion !== userTokenVersion` → refuse without family revocation ("logout all devices" is not theft).
7. `resolveCredentialSource('mcp_x', 'ps_at_y', profile)` → flag wins; `resolveCredentialSource(undefined, '  ', profile)` → profile (whitespace env is absent); `resolveCredentialSource(undefined, 'mcp_bad', profile)` with `mcp_bad` rejected by the server → auth error naming `PAGESPACE_TOKEN`, profile untouched and unused.
8. A flag/env credential is never refreshed and never written to the profile store (store write count = 0 across a full command run).
9. Profile store file is created 0600 and rewritten atomically (no window where the file is absent or partial — verifiable via injected fs).
10. `classifyRefreshFailure({kind:'http', status: 401})` → `purge-and-reauth`; `{status: 429}`, `{status: 503}`, and `{kind:'network'}` → `retryable`; a 429 result never triggers a credential purge; retries are bounded and honor `Retry-After` when present; the stale access token is never presented after `accessExpiresAt`.
11. `isValidTokenFormat` accepts `ps_at_*`/`ps_rt_*` post-extension; `authenticateRequest` given `Bearer ps_rt_*` on any API route → 401 (refresh tokens are not API credentials).
12. Provider `/token` refresh grant with a syntactically valid but unknown `ps_rt_*` → constant-shape 401 with no timing/shape oracle distinguishing "never existed" from "revoked".

## 8. Consequences

- Phase 1 adds refresh-token-family tables and the `at`/`rt` prefixes; **no refresh-token table exists today** (verified: `packages/db/src/schema/` greps for `refresh_tokens`/`refreshTokens` are empty — the `'ps_refresh'` string in `token-utils.ts:69-77` is a docstring example only), so this is greenfield with no legacy-data migration.
- Phase 1 also adds a narrow, 30s-TTL ephemeral grace cache (§3.4) — a new infra dependency beyond the primary hash-only token tables, scoped to exactly one purpose (recovering a dropped rotation response) and holding plaintext for no longer than the grace window.
- `authenticateRequest`'s `TokenType` union (`'mcp' | 'session'`, `apps/web/src/lib/auth/index.ts:15`) gains an `'oauth'` member; routes opt in via the existing `allow` allow-list — unchanged routes keep rejecting the new type (fail closed by default).
- Device tokens stay exactly as they are: an Electron/mobile-only mechanism. No `platform` enum change, no CLI coupling to `trustScore` columns, and the vestigial fingerprint machinery (§1.2) can be activated for browsers later without touching CLI auth.
- The devices/settings UI gains a sibling surface in Phase 1: active OAuth grants (CLI logins) listed and revocable per family.
- `mcp_*` tokens are untouched; CI documentation points at `PAGESPACE_TOKEN` + `pagespace tokens create`.
