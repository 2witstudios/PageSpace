# ADR 0002 — OAuth Scope Grammar & Client Model

- **Status:** Proposed (Phase 0 contract for the SDK/CLI/OAuth-provider epic)
- **Date:** 2026-07-03
- **Owners:** Phase 0, task 3 (`m05unrnntslsgdbjo5htjzk6`)
- **Depends on:** existing drive-scope capability model (PRs #1609 / #1745)
- **Consumed by:** Phase 1 (authorization server), Phase 2 (SDK auth providers), Phase 4 (CLI login), Phase 6 (remote MCP posture)

## Context

PageSpace already has a capability model for programmatic principals. This ADR's single job is to
define how OAuth 2.1 scope strings serialize **that** model — not to invent a parallel one.

The existing model, verified in source:

- An MCP token is authenticated by SHA3-256 hash lookup and resolves to
  `{ userId, tokenId, allowedDriveIds }` (`apps/web/src/lib/auth/index.ts:24-32`, `:67-154`).
  `TokenType` today is `'mcp' | 'session'` (`apps/web/src/lib/auth/index.ts:15`).
- A **scoped** token (≥1 drive row) acts as an "app member"; an **unscoped** token or a session
  acts as the user (`apps/web/src/lib/auth/principal-permissions.ts:43-49`). Every
  MCP-accepting route dispatches through the `*Principal*` helpers, which fork between the user
  path and the app path (`principal-permissions.ts:51-127`).
- Drive scopes live in `mcp_token_drives`: one row per (token, drive) with
  `role: MemberRole | NULL` and `customRoleId` (`packages/db/src/schema/members.ts:179-194`).
  `role = NULL` means **INHERIT** — the token acts with its owner's access in that drive; an
  explicit role is an opt-in downgrade meaning exactly what the same role means for a human
  member (`members.ts:183-185`, `packages/lib/src/permissions/app-permissions.ts:14-24`).
  `MemberRole` is `'OWNER' | 'ADMIN' | 'MEMBER'` (`members.ts:8`).
- Explicit-role resolution is already a pure function:
  `resolveExplicitAppRoleAccess` (`app-permissions.ts:88-128`) — admin-like → full access
  including private pages (`:105-107`); custom role → per-page grants, drive-wide fallback
  never on private pages, `canDelete` always false (`:109-117`); plain MEMBER → non-private
  view-only except channels, which grant `canEdit` (`:126-127`).
- Minting is capability-capped at the granting user's own authority
  (`apps/web/src/app/api/auth/mcp-tokens/route.ts:44-98`): must be owner/member of each drive
  (`:52-55`), a non-admin cannot grant ADMIN (`:56-59`), a custom role must belong to the drive
  (`:60-64`), and a non-admin may only use their **own** assigned custom role (`:65-71`).
- Fail-closed precedents we inherit: a scoped token whose drives were all deleted is denied
  entirely (`apps/web/src/lib/auth/index.ts:126-135`, backed by `mcp_tokens.isScoped`,
  `packages/db/src/schema/auth.ts:110-112`); a suspended owner's token is revoked on sight
  (`index.ts:105-122`).
- Tokens are opaque `ps_{type}_{random}` / `{prefix}_{cuid2}` strings, SHA3-256 hashed at rest
  (`packages/lib/src/auth/opaque-tokens.ts:17-26`, `packages/lib/src/auth/token-utils.ts:42-44`,
  `:80-89`). Never JWTs (epic decision).
- The old standalone MCP server (`/Users/jono/production/pagespace-mcp`, v5.2.3 per its
  `package.json:3`) authenticates with a single static bearer token
  (`src/api.js:53`, `:95`) — the credential this epic replaces with real login.

What does **not** exist yet (verified absent on this branch): no OAuth authorization-server
routes, no `/.well-known/oauth-authorization-server` metadata (grep of `apps/web/src` for
`well-known` returns nothing), no client registry. The `pkce.ts` / `oauth-utils.ts` machinery is
PageSpace acting as an OAuth **client** to Google/Apple (`packages/lib/src/auth/pkce.ts:1-15`,
`oauth-utils.ts:34,92`), not as a provider.

## Decision 1 — Scope grammar

Scope strings are a space-delimited list per RFC 6749 §3.3. The grammar (ABNF):

```abnf
scope-list   = scope *( SP scope )
scope        = "account" / "offline_access" / drive-scope
drive-scope  = "drive:" resource-id [ ":" drive-role ]
drive-role   = "admin" / "member" / ( "role:" resource-id )
resource-id  = 1*32( DIGIT / %x61-7A )   ; lowercase alphanum, cuid2-shaped
```

Scope tokens and their meaning:

| Scope | Meaning | DB representation (grant) |
|---|---|---|
| `account` | Full-user grant: the principal **is** its owning user, everywhere. | No drive rows; grant marked unscoped (analog of `mcp_tokens.isScoped = false`, `auth.ts:110-112`). |
| `drive:<driveId>` | Inherit-scoped: acts with its owner's access, only in this drive. | Drive row with `role = NULL` (`members.ts:183-186`). |
| `drive:<driveId>:admin` | Explicit ADMIN in this drive. | Drive row `role = 'ADMIN'`. |
| `drive:<driveId>:member` | Explicit plain MEMBER in this drive. | Drive row `role = 'MEMBER'`, `customRoleId = NULL`. |
| `drive:<driveId>:role:<roleId>` | Custom drive role. | Drive row `role = 'MEMBER'`, `customRoleId = <roleId>`. |
| `offline_access` | Request a refresh token (OAuth 2.1 convention). Must accompany `account` or ≥1 `drive:*` scope — see rule 10. | Grant flag; orthogonal to access scopes. |

Grammar rules (each is a testable assertion; all fail closed):

1. **Unknown scope token → reject the whole request** with `invalid_scope`. No silent
   filtering, no partial grants. (Zero trust: an unrecognized scope is an attack until proven
   otherwise.)
2. **Empty or missing `scope` → reject.** We deliberately refuse RFC 6749's "default scope"
   allowance; there is no implicit `account`.
3. **`account` is mutually exclusive with any `drive:*` scope → reject the combination.** The
   underlying model is binary — unscoped principals act as the user, scoped principals act as
   app members (`principal-permissions.ts:47-49`); a mixed request is ambiguous and therefore
   invalid.
4. **Duplicate `drive:<id>` entries (any roles) → reject.** Stricter than the mint route, which
   dedupes last-wins via a `Map` (`mcp-tokens/route.ts:42`); an OAuth request that says
   `drive:X:admin drive:X:member` is a contradiction, not a preference.
5. **`OWNER` is not grantable via scope.** The grammar has no `:owner` — parity with the mint
   schema, which only accepts `ADMIN | MEMBER` (`mcp-tokens/route.ts:24`). (`OWNER` exists in
   the enum for membership rows, not for token grants.)
6. **Custom role implies MEMBER.** `drive:<id>:role:<rid>` always stores `role = 'MEMBER'` +
   `customRoleId`. Rationale: the resolver ignores `customRoleId` when `role` is NULL (inherit
   short-circuits at `app-permissions.ts:138-141`) and when role is admin-like (`:105-107`) —
   the only branch where a custom role has meaning is the explicit non-admin branch
   (`:109-117`). The current mint schema permits `customRoleId` with omitted role
   (`mcp-tokens/route.ts:22-26`), which silently produces an inherit row whose custom role is
   dead weight; the grammar makes that unrepresentable.
7. **`resource-id` is shape-validated by the pure parser** (`^[a-z0-9]{1,32}$`, matching cuid2
   ids as generated by `createId()` — `members.ts:180`); **existence and authority are
   validated only at consent/mint time against the DB**, never trusted from the client.
8. **Scopes narrow, never widen.** Any flow that re-issues tokens (refresh rotation, future
   token exchange) MUST issue scope ⊆ the original grant; a broader request → `invalid_scope`.
   Comparison is by the canonical parsed set, not string equality.
9. **Canonical serialization:** scopes are emitted sorted (`account`/`offline_access` first,
   then `drive:*` by drive id), lowercase, single-space separated. `parse ∘ format` is the
   identity on canonical sets (round-trip law for tests).
10. **`offline_access` alone → reject.** Decision 2 defines a principal shape for `account` and
    for any `drive:*` set, but none for a grant with neither. A refresh token issued for such a
    grant could only ever mint access tokens with no access scope — meaningless, and a
    zero-trust liability (a token that exists but authorizes nothing invites callers to assume
    it authorizes something). `offline_access` MUST be combined with `account` or at least one
    `drive:*` scope in the same request. (Found by independent review, Codex P2 on PR #1754.)

### Considered and rejected: resource-family scopes (`pages:read`, `tasks:write`, …)

Rejected for this epic. The enforcement layer PageSpace actually has is drive-scoped RBAC
resolved per page (`principal-permissions.ts`, `app-permissions.ts`); there is no verb-level
capability model anywhere in `packages/lib/src/permissions/`. Verb scopes would have to be
enforced by a **new, parallel** check running beside the principal helpers — exactly the
failure mode this ADR exists to prevent. The grammar stays extensible (new top-level tokens can
be added under rule 1 without reinterpreting existing ones), so verb scopes can be introduced
if and when a verb capability model lands in the permission layer first.

## Decision 2 — Resolution contract: what `authenticateRequest` resolves each scope to

Phase 1 extends the auth layer with an OAuth access-token type (opaque `ps_*` prefix; exact
prefix naming is ADR 0003's decision — no conflict, this ADR only fixes the resolution
semantics). The contract:

| Granted scope set | Auth result shape | Permission dispatch |
|---|---|---|
| `account` | User principal: `{ userId, allowedDriveIds: [] }` — same shape sessions and unscoped MCP tokens resolve to today (`index.ts:24-39`). | User path of every `*Principal*` helper — e.g. `getUserAccessLevel` (`principal-permissions.ts:55-58`, `packages/lib/src/permissions/permissions.ts:92`). |
| Any `drive:*` set | Scoped principal: `{ userId, principalScopeId, allowedDriveIds: [driveIds…] }` — the OAuth analog of `MCPAuthResult` (`index.ts:24-32`), where `principalScopeId` keys the grant's drive rows exactly as `tokenId` keys `mcp_token_drives` today. | App path: `getAppAccessLevel`-family resolution (`app-permissions.ts:130-156`) with **identical** semantics per row: `NULL` → inherit via owner (`:138-141`), explicit → `resolveExplicitAppRoleAccess` (`:88-128`). |

Hard requirements on Phase 1's implementation:

- **Reuse, don't fork.** The OAuth grant's per-drive rows must carry the same
  `(driveId, role, customRoleId)` triple as `mcp_token_drives` (`members.ts:179-194`) and must
  be resolved by the same code path (parameterize `fetchAppMembershipContext`'s key or store
  grants in a shared scope table — Phase 1's schema call). Behavioral parity with the tables in
  this ADR is the acceptance test, and `resolveExplicitAppRoleAccess` is the oracle.
- **Consent = minting.** The consent handler must enforce the same authority caps as the mint
  route, cited above (`mcp-tokens/route.ts:44-98`): drive membership required, non-admin cannot
  grant `admin`, custom role must belong to the drive, non-admin may only grant their own
  assigned custom role. Any violation rejects the **entire** authorization request.
- **Grant-time authority is not resolution-time authority.** Inherit rows already degrade with
  the owner (a dangling inherit row grants nothing — `app-permissions.ts:158-170`); suspension
  parity with `index.ts:105-122` and scoped-with-zero-drives denial parity with
  `index.ts:126-135` are mandatory for OAuth principals.
- **No oracle responses.** Pre-consent scope failures return uniform `invalid_scope` without
  revealing whether a drive id exists, is inaccessible, or has a foreign role. (Deliberate
  divergence from the mint route, which enumerates offending drive ids in its error body,
  `route.ts:74-97` — acceptable behind an authenticated CSRF-protected session UI, not on an
  OAuth endpoint reachable by arbitrary clients.)

## Decision 3 — Client model

- **Clients are pre-registered; the CLI is a first-party public client.**
  - `client_id: "pagespace-cli"` — human-assigned, stable, namespaced by convention
    (`pagespace-*` reserved for first-party).
  - `client type: public` (RFC 6749 §2.1). **No client secret exists**; possession of the
    binary confers nothing. Authentication of the authorization is PKCE only.
  - **PKCE S256 is mandatory** for every client on every authorization-code flow (OAuth 2.1
    baseline). `plain` is rejected. Unlike the existing client-side helper, which fails open
    when the DB is down (`packages/lib/src/auth/pkce.ts:8-11`, `:65-70` — acceptable when
    PageSpace is the *client*), the provider side **fails closed**: if the verifier cannot be
    stored or retrieved, the flow dies with an error, never "proceeds without PKCE".
  - **Grants allowed for `pagespace-cli`:** `authorization_code` (+ PKCE),
    `urn:ietf:params:oauth:grant-type:device_code` (RFC 8628, for headless/SSH), and
    `refresh_token` (rotation mandatory; reuse detection revokes the family — posture matches
    the device-token rotation precedent, `apps/web/src/app/api/auth/device/refresh/route.ts:110-137`).
- **Redirect URIs: loopback only, per RFC 8252 §7.3.**
  - Registered pattern: `http://127.0.0.1:{port}/callback` and `http://[::1]:{port}/callback`
    with **any** port. Matching is exact on scheme, host, and path; the port is the only wild
    component, and only for these two literal loopback hosts.
  - `http://localhost` is **rejected** (RFC 8252 §8.3: the name can be remapped; the numeric
    literal cannot).
  - Non-loopback `http`, any `https`, wildcards, userinfo, query strings, and fragments in a
    registered redirect are all rejected at registration and at authorize time. Unregistered
    `redirect_uri` → the request dies; there is **no** redirecting errors to an unvalidated URI.
  - The desktop app's existing `pagespace://auth-exchange` deep-link handoff
    (`packages/lib/src/auth/exchange-codes.ts:1-21`) stays as-is; a future
    `pagespace-desktop` client MAY register a private-use scheme URI (RFC 8252 §7.1) — the
    model accommodates it, this epic does not ship it.
- **First-party clients live in a static, code-reviewed registry** in
  `packages/lib/src/auth/oauth/` (pure data, no DB read on the hot path, not mutable via SQL).
  The DB schema Phase 1 adds for clients exists for **future** dynamically registered clients
  and stores: `clientId`, `name`, `type` (public only, until a confidential use case is
  reviewed), redirect URIs, allowed grants, `firstParty: false`, timestamps, revocation.
  Registry lookup order: static registry first; unknown `client_id` → reject (`invalid_client`).
- **Rate limiting:** every OAuth endpoint (authorize, token, device-authorization, revocation)
  gets a named config in the `RATE_LIMIT_CONFIGS` pattern
  (`packages/lib/src/auth/rate-limit-utils.ts:179-198`); the token endpoint additionally
  rate-limits per `device_code` poll per RFC 8628 §3.5 (`slow_down`).

## Decision 4 — Dynamic client registration (RFC 7591) & remote MCP posture

**Dynamic client registration does not ship in this epic.** The schema and discovery document
merely accommodate it:

- The Phase 1 client table carries everything RFC 7591 requires to be added later without
  migration pain (client metadata is a superset of the static registry shape).
- Phase 1 ships RFC 8414 discovery at `/.well-known/oauth-authorization-server` (none exists
  today — verified). The document omits `registration_endpoint` until registration ships;
  adding the field later is additive and spec-legal.
- Nothing here forecloses a future remote MCP endpoint. The MCP authorization spec requires:
  an OAuth 2.1 AS with PKCE (we mandate it), AS metadata discovery (we ship it), and
  recommends dynamic registration (schema-accommodated, additive). Opaque tokens are fine
  because the resource server and AS are the same deployment (`apps/web`), so validation is a
  local hash lookup (`token-utils.ts:42-44`) — no cross-service introspection needed. If a
  separate resource server ever appears, RFC 7662 introspection can be added without changing
  the token format.
- When registration does ship: registered clients are always `public` + PKCE, never
  first-party, scope-capped identically to everyone else (scopes grant nothing the consenting
  user can't do — Decision 2's authority caps make over-privileged clients structurally
  impossible).

## Decision 5 — Consent screen contract

The consent screen is part of the security boundary: zero trust includes the user being able
to trust what the screen says. Requirements:

1. **Parse-then-render, never render-then-filter.** The scope list is parsed and validated
   (Decisions 1–2, including DB authority checks) **before** any UI renders. An invalid request
   never reaches a consent screen; there is no "…and 2 unknown permissions".
2. **Names, not ids.** Drive and role names are resolved server-side from the validated ids.
   Raw ids render only alongside the name (tooltip/mono suffix), never alone.
3. **Per-scope narration** (exact copy is UI's; the *content* is contractual):

| Scope | The screen MUST convey |
|---|---|
| `account` | "Full access to your PageSpace account — everything you can see and do, in every drive, now and in the future." Visually flagged as the maximum grant. |
| `drive:<id>` | "Act as you in **{drive name}** — everything you can currently do there (your access, including future changes to it). No access to any other drive." |
| `drive:<id>:admin` | "Full admin access to **{drive name}** — view and edit all pages **including private pages**, manage sharing and deletion." (Admin sees private pages: `app-permissions.ts:105-107` — the screen must say so.) |
| `drive:<id>:member` | "Member access to **{drive name}** — view non-private pages and post in channels. Cannot edit other pages, share, or delete." (`app-permissions.ts:126-127`.) |
| `drive:<id>:role:<rid>` | "Access to **{drive name}** limited to the **{role name}** role" + the role's summarized capabilities from its stored permission set (`packages/db/src/schema/members.ts:11-23`), including whether it has drive-wide view. Never renders an unresolvable role — that request was already rejected (fail closed). |
| `offline_access` | "Stay connected until you revoke access (issues a long-lived refresh credential)." |

4. **Client identity:** display the client's registered name, and a "Built by PageSpace"
   badge if and only if `firstParty` — dynamically registered clients can never claim it.
5. **Re-consent:** a request whose scope set is not ⊆ the user's prior grant for that client
   requires fresh consent for the full new set. Subset requests may skip the screen.
6. **Revocation surface:** granted OAuth connections appear in the same settings surface as
   MCP tokens (list shape parity with `mcp-tokens/route.ts:149-163`), showing client name,
   scope narration, last-used, and one-click revoke.

## Pure-function signatures (Phase 1 task 3 implements these; RED tests come from the assertions in this ADR)

All side-effect-free; DB/clock/randomness injected at the edges. Location:
`packages/lib/src/auth/oauth/scopes.ts` (+ `clients.ts`), colocated tests in `__tests__/`.

```ts
type ParsedScope =
  | { kind: 'account' }
  | { kind: 'offline_access' }
  | { kind: 'drive'; driveId: string;
      role: { kind: 'inherit' } | { kind: 'admin' } | { kind: 'member' }
          | { kind: 'custom'; customRoleId: string } };

type ScopeSet = { account: boolean; offlineAccess: boolean;
                  drives: ReadonlyMap<string, ParsedScope & { kind: 'drive' }> };

type ScopeError =
  | { code: 'malformed_scope'; scope: string }
  | { code: 'unknown_scope'; scope: string }
  | { code: 'empty_scope' }
  | { code: 'account_drive_conflict' }
  | { code: 'duplicate_drive'; driveId: string }
  | { code: 'offline_access_alone' };

// Grammar (Decision 1). Total: never throws.
function parseScopeList(raw: string): { ok: true; scopes: ScopeSet } | { ok: false; error: ScopeError };

// Canonical serialization; parse(format(s)) deep-equals s (rule 9).
function formatScopeSet(scopes: ScopeSet): string;

// Narrowing (rule 8): true iff requested ⊆ granted. account ⊄ any drive set; drive:X:admin ⊄ drive:X:member; etc.
function isScopeSubset(requested: ScopeSet, granted: ScopeSet): boolean;

// Bridge to the capability model: rows in mcp_token_drives shape (Decision 2).
function scopeSetToDriveScopes(scopes: ScopeSet):
  Array<{ driveId: string; role: 'ADMIN' | 'MEMBER' | null; customRoleId: string | null }>;

// Consent-time authority check (Decision 2, mirrors mcp-tokens/route.ts:44-98).
// Caller fetches access facts; the decision itself is pure.
function checkGrantAuthority(
  scopes: ScopeSet,
  authority: ReadonlyMap<string, { isOwner: boolean; isMember: boolean; isAdmin: boolean;
                                   ownCustomRoleId: string | null;
                                   roleBelongsToDrive: (roleId: string) => boolean }>,
): { ok: true } | { ok: false; reason: 'no_access' | 'admin_not_grantable' |
                    'foreign_custom_role' | 'custom_role_not_in_drive'; driveId: string };

// Redirect validation (Decision 3). Exact match; port wild only on the two loopback literals.
function validateRedirectUri(client: RegisteredClient, redirectUri: string): boolean;

// Consent narration inputs (Decision 5): resolved names in, display strings out.
function describeScopeForConsent(
  scope: ParsedScope,
  ctx: { driveName?: string; roleName?: string; roleSummary?: string },
): string;
```

## Fail-closed posture (summary — every line is a RED test)

| # | Situation | Behavior |
|---|---|---|
| F1 | Unknown / malformed / empty scope | Reject request, `invalid_scope`, uniform body, no consent screen |
| F2 | `account` mixed with `drive:*` | Reject, `invalid_scope` |
| F3 | Duplicate drive id in scope list | Reject, `invalid_scope` |
| F4 | Consent authority cap violated (no access / admin-by-non-admin / foreign or cross-drive custom role) | Reject entire request; no partial grant; uniform error |
| F5 | Refresh/re-issue requests scope ⊄ grant | Reject, `invalid_scope` |
| F6 | Scoped grant with zero surviving drives | Deny authentication entirely (parity `index.ts:126-135`) |
| F7 | Owner suspended | Deny + revoke on sight (parity `index.ts:105-122`) |
| F8 | Inherit row whose owner lost the drive | Grants nothing (parity `app-permissions.ts:158-170`) |
| F9 | Unknown `client_id` / unregistered `redirect_uri` | Reject; never redirect to unvalidated URI |
| F10 | PKCE verifier missing/unstorable/mismatched on provider side | Flow fails; no PKCE-less fallback |
| F11 | Unresolvable custom role at consent render | Already rejected pre-render (F4); screen never shows placeholders |
| F12 | Scope needed but DB unreachable at any decision point | Deny (no cached/assumed authority) |
| F13 | `offline_access` requested alone (no `account`, no `drive:*`) | Reject, `invalid_scope` (rule 10) |

## Consequences

- Phase 1 implements the grammar, client registry, consent flow, and discovery doc against the
  signatures and assertions above; `resolveExplicitAppRoleAccess` and `getUserAccessLevel`
  remain the only permission oracles.
- Phase 2's SDK auth providers and Phase 4's `pagespace login` consume `pagespace-cli` +
  loopback PKCE + device grant exactly as specified; no client secrets ever ship in the binary.
- The scope grammar becomes a public contract on par with the API surface (ADR 0001/0003
  govern versioning and credential formats): tokens are only ever **added**, never
  reinterpreted.
- One epic-page pointer is corrected by this ADR's research: `principal-permissions.ts` lives
  at `apps/web/src/lib/auth/principal-permissions.ts` (re-exported via
  `apps/web/src/lib/auth/index.ts:584-598`), not under `packages/lib/src/permissions/`.
