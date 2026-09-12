# ADR 0004 — Third-Party OAuth Clients ("Sign in with PageSpace")

- **Status:** Proposed (Phase 0 contract for the "Sign in with PageSpace" epic)
- **Date:** 2026-09-11
- **Deciders:** Sign in with PageSpace epic (epic page `yv08hib74nrtmksdzxmf5nkw`, Phase 0 page
  `kb5oh1ngdlwn1aw5rd48ml6g`, ADR task `g6n4aoy2d1ne38uzamvvvaz1`)
- **Amends:** ADR 0002 Decision 3 (client model), Decision 4 (dynamic registration posture), and
  Decision 1 (the grammar: one new token, `profile`, and its interaction rules 14–14c, 15, 10′, 9′).
  Additive only. No rule is reinterpreted and no previously-valid scope string changes meaning —
  rules 10 and 13 gain a `profile` term, but `profile` did not exist before this ADR, so every string
  that parsed yesterday parses identically today and resolves to the same principal.
- **Consumed by:** Phase 1 (provider opens to third parties), Phase 2 (resource server),
  Phase 3 (SDK sign-in), Phase 4 (platform-managed env clients), Phase 5 (SwipeSend).

## Context

PageSpace is already an identity provider. What it lacks is anyone to be an identity provider
*for*.

Verified on `pu/signin-with-pagespace`, 2026-09-10:

- A full OAuth 2.1 authorization server ships today: authorize, consent, token (authorization
  code / device code / refresh), revoke, and RFC 8414 discovery
  (`apps/web/src/app/api/oauth/{authorize,token,revoke,device_authorization}/route.ts`), with
  PKCE S256 mandatory and fail-closed, single-use codes with family revocation, and refresh
  rotation with reuse detection.
- The auth layer already resolves an OAuth principal at the door:
  `TokenType = 'mcp' | 'session' | 'oauth' | 'service'`
  (`apps/web/src/lib/auth/index.ts:27`), with `isScopedOAuthAuth` /
  `getScopedAccessLevel` fanning it out through the same `*Principal*` helpers MCP tokens use
  (`apps/web/src/lib/auth/principal-permissions.ts`).
- The client registry has exactly one entry. `pagespace-cli` is defined in code, redirect URIs
  are loopback-only, and `getRegisteredClient` is synchronous
  (`packages/lib/src/auth/oauth/clients.ts`). The `oauth_clients` table exists
  (`packages/db/src/schema/oauth.ts:12-24`: `clientId`, `name`, `clientType`, `redirectUris`,
  `isFirstParty`, `disabledAt`) but is populated only by `ensureOAuthClientRow` so that token
  rows have a foreign key to point at (`apps/web/src/app/api/oauth/revoke/route.ts:70`).
- A `drive:*` or `all_drives` grant does not mint an OAuth token pair at all: it mints a real
  `mcp_` key (`apps/web/src/lib/repositories/oauth-repository.ts:250-251`, the
  `isAllDrivesGrant || isPureDriveGrant` branch calling `applyKeyGrant`, `:201`). That is
  correct, deliberate CLI behaviour — and exactly wrong for a third-party web app.
- There is no identity-only scope, and `POST /api/oauth/authorize` requires the step-up
  ceremony on **every** consent.

So "Sign in with PageSpace" is not a new auth system. It is: let other clients exist, stop
minting keys for them, add a scope that means only "who are you", and stop demanding a second
factor for that one case. Every decision below is one of those four things or a consequence of
them.

The user stories this serves are US1–US11 on the epic page; the ones that bear on this ADR most
directly are **US8** (an identity-only app must not force a passkey ceremony) and **US10**
(nothing here weakens zero trust).

## Decision 1 — Public clients and PKCE only

No client secrets, anywhere, for anyone. `confidential` stays in the `oauth_client_type` enum
and stays unimplemented.

A secret would have to live somewhere: a sandbox env var, an iOS bundle, a repo. PageSpace
already holds the invariant that **no secrets enter a sandbox**
(`packages/lib/src/services/sandbox/sandbox-env.ts`), and Decision 12 below puts a
`PAGESPACE_CLIENT_ID` there. That only stays safe while a `client_id` is a public value. PKCE
S256 — already mandatory and already fail-closed on the provider side (ADR 0002 Decision 3) — is
what authenticates the authorization.

## Decision 2 — Registry lookup: static first, then `oauth_clients`

`getRegisteredClient` becomes an async `resolveClient(clientId)`: the static registry in
`packages/lib/src/auth/oauth/clients.ts` first, then `oauth_clients` where
`disabledAt IS NULL`. Unknown, disabled, and foreign-redirect clients all produce the same
`invalid_client` — no oracle (ADR 0002 Decision 2's "no oracle responses", extended to client
identity).

First-party clients stay in code. That is the whole point of keeping two sources: `firstParty`
is what grants the loopback wildcard (Decision 3) and the `mcp_` mint path (Decision 5), and
neither may ever be reachable by a SQL write or a registration form. `RegisteredClient.verified`
is likewise server-set, never client-supplied
(`packages/lib/src/auth/oauth/clients.ts`, `RegisteredClient`).

Phase 1 owns the DB half. Phase 0 ships the static registry unchanged (`getRegisteredClient` and
`PAGESPACE_CLI_CLIENT_ID` keep their exact signatures and behaviour) plus the metadata fields
the table will carry: `logoUrl`, `homepageUrl`, `description`, `ownerUserId`, `allowedScopes`,
`verified`.

## Decision 3 — Redirect URI rules (amends ADR 0002 Decision 3)

ADR 0002 Decision 3 says loopback only, `https` rejected, private-use schemes accommodated but
not shipped. That was correct for a registry containing one CLI. It is amended as follows —
**one pure function, `validateRedirectUri`, used at registration time AND at authorize time**.
Two implementations of "is this redirect valid" is how an app registers a URI the authorize
endpoint will not honour, or — in the direction that actually hurts — one it will.

| Candidate | Accepted when |
|---|---|
| `https://host[:port]/path` | exact match against a registered https URI after URL normalization — scheme, host, port and path, all of them |
| `scheme://…` (private use, RFC 8252 §7.1, e.g. `swipesend://callback`, `com.example.app://oauth/callback`) | exact match against a private-use URI registered **on that client** |
| `http://127.0.0.1[:port]/path`, `http://[::1][:port]/path` | scheme, host and path match a registered loopback URI **and `client.firstParty`** — the port is the only wildcard in the system |
| anything else | never |

Rejected before any registration is consulted: userinfo, query, fragment, `*` anywhere,
`localhost` under any scheme (RFC 8252 §8.3 — the name can be remapped, the numeric literal
cannot), non-loopback `http://`, and every script- or content-bearing scheme (`javascript:`,
`data:`, `file:`, `blob:`, `about:`, `vbscript:`, `ws(s):`), registered or not.

Three details are load-bearing and each is mutation-checked:

- **The loopback wildcard is first-party only.** A third party that registers
  `http://127.0.0.1/callback` gets nothing — not the wildcard, and not its own exact port
  either. Cleartext loopback is a native-app affordance for a client that already runs on the
  user's machine; an app the user reaches over the web has no business with it.
- **Candidates are only matched against registrations of the same kind**, so a private-use
  registration can never satisfy an https candidate through a parser coincidence.
- **The loopback branch compares host and path only** (the kind check already settles the
  scheme), which means a registered loopback URI carrying a query, fragment or userinfo grants
  nothing rather than quietly acting as a clean one.

**Scheme classification is a deny-list, deliberately.** `https:` and `http:` are allow-listed — each
has one accepting condition and everything else is refused. Private-use schemes cannot be: RFC 8252
§7.1 says the scheme is one the app itself chose, so an allow-list would have to enumerate every app
that will ever exist. A scheme that is neither http(s) nor on the deny-list therefore classifies as
private-use and is registrable. The deny-list covers three groups: script- and content-bearing
(`javascript:`, `vbscript:`, `data:`, `blob:`, `about:`, `file:`), URL-wrapping (`filesystem:`,
`view-source:`, `jar:` — each carries a second URL inside it, so accepting one hands the
authorization code to whatever that inner URL addresses), and platform-handled (`chrome:`,
`chrome-extension:`, `resource:`, `content:`, `intent:`, `android-app:`, `mailto:`, `tel:`, `sms:`).

**The residual exposure is scheme squatting, and it is accepted rather than solved.** Nothing stops
a registration claiming `slack://oauth`; on a shared device the OS hands the code to whichever app
claimed the scheme. Requiring a reverse-DNS scheme (`scheme.includes('.')`, per RFC 8252 §7.1's
recommendation) would blunt it, and is rejected for now only because it would refuse the shape this
epic's reference app uses (`swipesend://callback`, US5). What stands in front of it today: exact-match
registration, per-client scope caps (Decision 7), and the "Unverified app" badge (Decision 8). Phase 1
should decide whether registration nudges or requires reverse-DNS; the decision belongs with the
console UI that would have to explain it.

**`https://` on a numeric loopback host is ordinary https, not loopback.** `loopback` in this rule
means CLEARTEXT loopback. A third party may register `https://127.0.0.1/callback` and gets exact
matching only — the port wildcard, which is the whole thing the first-party gate protects, is not
granted. Raised as a possible bypass in review and pinned by test in both directions rather than left
unasserted.

ADR 0002's statement that the desktop app's `pagespace://auth-exchange` handoff
(`packages/lib/src/auth/exchange-codes.ts`) stays as-is is unchanged; a future
`pagespace-desktop` first-party client may now register that private-use URI under this rule
rather than under a future amendment.

## Decision 4 — The `profile` scope

Another top-level scope token, added under ADR 0002 rule 1's extensibility clause. **No verb
scopes** — ADR 0002's rejection of `pages:read` and friends stands, and nothing here creates a
parallel enforcement layer.

`profile` grants exactly the identity fields `/api/auth/me` already returns for an OAuth
principal — name, email, avatar — and zero content access. It short-circuits the same way
`manage_keys` does (ADR 0002 Decision 2's `isManageKeysOnly` row): no drive, page, task or
channel read or write is reachable with it.

Grammar rules, extending ADR 0002 Decision 1 (each is a test in
`packages/lib/src/auth/oauth/__tests__/profile-scope.test.ts`):

| # | Rule | Error |
|---|---|---|
| 14 | `profile` is mutually exclusive with `account` | `profile_account_conflict` |
| 14a | `profile` with `manage_keys` or `all_drives` | the existing `manage_keys_conflict` / `all_drives_conflict` |
| 14b | `profile` with `update_key:*` / `activate_key:*` | the existing `update_key_conflict` / `activate_key_not_alone` |
| 14c | `name:*` alongside `profile` — rule 13's mint-shape exclusion gains `profile`, because a profile-bearing set is no longer mint-shaped | `name_without_mint_grant` |
| 15 | `profile` combines with any `drive:*` set and with `offline_access` | — |
| 10′ | rule 10 (`offline_access` alone → reject) is **extended**: `profile` is a principal shape, so `profile offline_access` is valid. `offline_access` alone is still rejected | `offline_access_alone` |
| 9′ | canonical order (rule 9) keeps the top-level flags alphabetical — `account`, `all_drives`, `manage_keys`, `offline_access`, `profile` — so `profile` emits after `offline_access` and before `drive:*`. `parse ∘ format` is still the identity | — |

Two readings had to be chosen, and both went the fail-closed way:

- **`profile account` is rejected, not collapsed.** Collapsing to `account` would hand an
  identity-only app the maximum grant; collapsing to `profile` would silently withhold access
  the user was shown and approved. `account` is already a superset of the identity fields in
  *capability*, but it is not a superset in *consent*, and the grammar does not assert
  cross-shape narrowing anywhere else either (ADR 0002 rule 8's treatment of `manage_keys` and
  `all_drives` is the precedent this follows).
- **`profile manage_keys` is rejected**, by analogy with ADR 0002 rule 11 rather than in spite
  of it. Rule 11 excludes `manage_keys` from content scopes because the principal shape is one
  or the other; `manage_keys` resolves through a short-circuit that denies everything else, and
  a grant that is simultaneously "deny all content" and "release identity" has no single
  resolution at the door. Rejecting costs a first-party convenience (`pagespace login` asking
  for both at once) and buys an unambiguous principal — see [D-11] under Decided below for how
  the CLI gets `profile` anyway.

Narrowing (rule 8): `profile ⊄` any drive set, `⊄ account`, `⊄ all_drives`; a granted `profile`
satisfies nothing but another `profile`, and never makes a `drive:*` request a subset.

One consequence is load-bearing beyond the grammar: **`isPureDriveGrant` now excludes
profile-bearing sets**. An `mcp_tokens` row carries drive rows and nothing else, so it
structurally cannot deliver the identity half of a `profile drive:*` grant. Without this, a
`profile drive:abc123` request would fall into the `applyKeyGrant` branch
(`oauth-repository.ts:250`) and silently mint a long-lived `mcp_` key where the user consented
to a sign-in.

That exclusion has a second consequence, caught in review: `validateAuthorizeRequest`'s "a
mint-shaped grant requires a `name:`" guard fires only for `isPureDriveGrant || isAllDrivesGrant`, so
`profile drive:abc123 name:ci` would have sailed past it and then minted nothing — a consent screen
narrating "create a key named ci" over an exchange that produces an ordinary OAuth pair. It fails in
the safe direction (less is minted than promised) but it is still the consent screen lying, which is
the one thing US10 forbids. Rule 13 therefore excludes `profile` outright: the promise is rejected,
not the grant, and the same set without `name:` still parses.

Consent narration (ADR 0002 Decision 5 point 3, one more row): *"See your name, email, and
avatar. No access to any drive or content."* The second sentence is contractual, not decoration
— `profile` is the one scope approved without a second factor, so the screen must say plainly
what is and is not being handed over. `SCOPES_SUPPORTED` in
`packages/lib/src/auth/oauth/metadata.ts` advertises it.

**That second sentence is a claim about the SET, and it is emitted opt-in.** `profile drive:abc123`
is a legal grant, and rendering "No access to any drive or content" above "Act as you in Acme Drive"
is a contradiction on the one surface that has to be trustworthy — it shipped that way for an hour
on `/api/account/oauth-grants` before review caught it. `describeScopeForConsent` therefore emits the
absolute sentence only when the caller passes `ctx.profileIsSoleAccess`, which only a caller holding
the whole set can honestly affirm; without it the narration is the identity sentence alone, which is
true of every `profile` grant. The default is the weaker claim deliberately: a caller that forgets
the flag under-claims, and under-claiming is recoverable in a way that a false reassurance is not.

The corollary is a rule for Phase 1: **a surface that narrates scopes calls `describeGrantScopes`
rather than re-deriving the narration.** Three surfaces re-derive it today — the loopback consent
page, the device-flow verify route, and the connected-apps listing — and `profile` had to be taught
to each separately, which is exactly why two of them currently render a `profile` grant as an empty
capability list. See "Phase 1 obligations" below.

## Decision 5 — Issuance is per-client

`applyKeyGrant` — the branch that mints a real `mcp_` key for a pure `drive:*` or `all_drives`
grant (`apps/web/src/lib/repositories/oauth-repository.ts:201,250-251`) — runs **only when
`client.firstParty`**. Every other client gets an ordinary `ps_at_` / `ps_rt_` pair carrying the
drive scopes, resolved as a scoped OAuth principal.

This is US2 and US10 in one line. A third-party app holding an `mcp_` key would hold a
credential that outlives the grant, appears in `keys list` as something the user did not create,
and is revoked through a different surface than the app that obtained it. ADR 0003's credential
model is unchanged for the CLI: `mcp_` keys remain the non-interactive credential, and OAuth
tokens keep meaning "a user signed in".

The `name:` requirement in `validateAuthorizeRequest`
(`packages/lib/src/auth/oauth/authorize-request.ts`, ADR 0002 rule 13's enforcement half)
becomes **first-party only**, for the same reason: it exists because a minted key needs a name,
and nothing is being minted.

## Decision 6 — The step-up boundary

`requiresStepUp(scopes)` (`packages/lib/src/auth/oauth/step-up-boundary.ts`) is **true iff** the
set grants content access (`drive:*`, `all_drives`, `account`) or touches key material
(`manage_keys`, `update_key:*`, `activate_key:*`), and **false** only for `profile` and
`profile offline_access`. `profile` alone gets a plain, CSRF-protected Allow.

It is one pure function because the screen that decides whether to *offer* the ceremony and the
server that decides whether to *require* one must read the same answer. Two expressions of that
rule is how a future scope lands on a screen that never runs the ceremony — or on a server that
stops demanding one. The same drift is why `isCredentialEscalatingGrant` exists one layer down
(`packages/lib/src/auth/oauth/scopes.ts`), and this function is deliberately its sibling, not
its replacement: that one answers "does approving this escalate the approver's credentials", a
narrower question the device flow asks.

The decision is expressed as a per-field map closed by
`satisfies { readonly [K in keyof ScopeSet]: (value: ScopeSet[K]) => boolean }`, so **a new
`ScopeSet` field fails to compile here** until someone states whether it can be approved without
a second factor. The fail-closed default for that statement is `true`. Verified by adding a
probe field to `ScopeSet` and observing `step-up-boundary.ts:64: error TS1360`.

### Phase 1 obligations this decision creates

Recorded here because Phase 0 ships the contract and Phase 1 ships the enforcement; the gap between
them is designed, not accidental, and it must not become the thing everyone assumed someone else did.

1. **`profile` is advertised before it is enforced.** This phase puts `profile` into
   `SCOPES_SUPPORTED` (the live RFC 8414 document) and into the accepting path of `parseScopeList` →
   `validateAuthorizeRequest` → exchange, while "short-circuits the same way `manage_keys` does" is
   implemented nowhere. A `profile`-only principal resolves to `allowedDriveIds: []`, and
   `checkMCPDriveScope` (`apps/web/src/lib/auth/index.ts:785`) reads an empty list as "unscoped", i.e.
   **allowed for any drive** — the exact shape `validateOAuthAccessToken:349-360` refuses to issue for
   `all_drives`, and the reason `manage_keys` got the `manageKeysNoDriveAccess` sentinel
   (`index.ts:750`). 93 route files call `checkMCPDriveScope`. **Phase 1 acceptance line:**
   `checkMCPDriveScope` and `getAllowedDriveIds` deny a profile-only OAuth principal, via an
   `isProfileOnly` sentinel beside `manageKeysNoDriveAccess` — mutation-checked. Until that lands, the
   consent copy this phase adds ("No access to any drive or content") is a promise about Phase 1, not
   a description of today.
2. **`requiresStepUp` is not yet the single place step-up is decided.** Production still decides it
   via `isCredentialEscalatingGrant` (`device_authorization/verify/route.ts:82`,
   `device_authorization/decision/route.ts:98`) and via the unconditional step-up on `POST
   /api/oauth/authorize`. Phase 1 replaces both with this function; until then there are two
   expressions of the rule, which is the drift this decision exists to prevent.
3. **`isHttpsUrl` is not an SSRF guard.** It checks protocol and userinfo only, so
   `https://169.254.169.254/` and `https://localhost/logo.png` both pass. That is correct today —
   `logoUrl` is rendered by the browser and never fetched server-side. The moment anything proxies,
   caches or screenshots that logo it becomes an SSRF, and
   `packages/lib/src/security/url-validator.ts` already has `isBlockedIP`/`validateExternalURL`/
   `safeFetch` for it.
4. **Registration rejections are an abuse signal.** Phase 1's route should emit a security-audit
   event on rejection; repeated `forbidden_scope` from one owner is worth seeing.
5. **Two of the three scope-narrating surfaces have no `profile` branch.** The loopback consent page
   (`apps/web/src/app/oauth/consent/page.tsx:114-157`) and the device-flow verify route
   (`apps/web/src/app/api/oauth/device_authorization/verify/route.ts:66-156`) each build
   `scopeDescriptions` with a hand-written if-chain over `ScopeSet` fields instead of calling
   `describeGrantScopes`, so a `scope=profile` request renders the app name above an **empty**
   capability list and Allow still mints the code — the user approves a grant the screen never named.
   **Acceptance:** both call `describeGrantScopes`; a `profile`-only consent renders a non-empty list.
   The structural half outlives the `profile` half — as long as three surfaces each re-derive scope
   meaning, the next scope gets missed the same way.
6. **`profile` is reachable through the live doors today.** `POST /api/oauth/device_authorization`
   accepts `scope=profile` for `pagespace-cli` ([D-11] permits it); `isCredentialEscalatingGrant` is
   false for `profile`, so `/activate` runs no step-up; and `profile offline_access` satisfies rule
   10, so the credential is refreshable. With obligation 1 open, the token that flow issues is
   admitted to every drive the user has. Not a production exposure — the epic converges to master as
   one reviewed PR after Phase 6's security review — but "Phase 1 will handle it" and "nothing can
   reach it before Phase 6" are different claims, and only the second one is load-bearing.

## Decision 7 — Per-client scope caps

A client declares `allowedScopes` at registration; it cannot even *ask* beyond what it declared,
checked at authorize time before consent renders. This is defence in depth, not the primary
control — Decision 2's authority caps (ADR 0002 Decision 2: consent can never grant what the
consenting user does not have) remain the thing that makes over-privileged clients structurally
impossible. The cap is what stops a compromised or careless app from *asking* for a drive when
it advertised itself as a sign-in button, and what lets a console show a user what an app is
even allowed to request.

**`allowedScopes` holds scope SHAPES, not scopes.** A cap says "this app may ask for member
access to some drive"; which drive is the user's choice at consent time. The shape grammar:

```abnf
scope-shape = "profile" / "offline_access" / drive-shape
drive-shape = "drive" / "drive:admin" / "drive:member" / "drive:role"
```

`drive` is the inherit shape (`drive:<id>`), `drive:role` stands for the whole
`drive:<id>:role:<roleId>` family. A concrete scope where a shape belongs — `drive:abc123`,
`drive:abc123:member` — is rejected, as firmly as `account`, `all_drives`, `manage_keys`,
`update_key`, `activate_key` and `name:` are. An empty `allowedScopes` array is a form mistake,
not "no cap": reading `[]` as unrestricted would turn the safest-looking input into the widest
one.

Validation is `validateClientRegistration`
(`packages/lib/src/auth/oauth/client-registration.ts`): `unknown` in, a typed error union out,
never throws, every problem reported at once with the field that caused it. Name 1–100 and description ≤500, both held to the display-text rule mcp key names already
meet (no control characters, no bidi overrides or directional isolates, no zero-width characters
— they render beside the "Unverified app" badge, and ADR 0002 Decision 5 makes what the screen says
part of the security boundary; the name additionally may not be whitespace-only or carry leading or
trailing whitespace, and is rejected rather than silently trimmed). `logoUrl`/`homepageUrl` https-only (an `http:` logo is a mixed-content
downgrade on the consent screen; `javascript:`/`data:` on a rendered link or image is the whole
attack), 1–10 redirect URIs each passing Decision 3's rules **as a non-first-party client**, no
duplicates. The accepted value is rebuilt field by field, so `firstParty`, `verified` or an id
cannot ride in on the request body.

## Decision 8 — What the consent screen renders

Name, logo and homepage from the client record. "Built by PageSpace" **iff** `firstParty` — a
registered client can never claim it, because `firstParty` only exists in code (Decision 2).
"Unverified app" **iff** `!verified`, which is the default for everything that arrives through
registration.

## Decision 9 — CORS on the token, revoke and discovery responses

`/api/oauth/token`, `/api/oauth/revoke` and the well-known documents must be readable
cross-origin. Today the public-allowlist branch of `apps/web/src/middleware.ts` returns
`createSecureResponse` **without** CORS headers, while `applyApiCorsHeaders` (`:225,:244`) runs
only on OPTIONS and on `Bearer mcp_|ps_sess_|ps_at_` requests — so a browser SDK can send the
form-encoded POST and never read the reply.

A form-encoded POST is a simple request and needs no preflight; this is only about the response
being readable. It grants no new capability: the token endpoint's security rests on PKCE and the
single-use code, never on origin.

## Decision 10 — Every route that accepts `mcp` accepts `oauth`

Enforced by a repo guard test rather than by review. 101 route files are `allow: ['session',
'mcp']` today and 6 accept `'oauth'`; an OAuth principal resolves through the identical
`*Principal*` helpers, so any route where an `mcp_` key works and an OAuth token does not is an
oversight, not a policy.

Explicit deny list (these accept neither, and the guard asserts the exclusion): the consent
POST, step-up endpoints, billing/Stripe, and account deletion.

## Decision 11 — The SDK owns the token-endpoint helpers

The Node implementations in `packages/cli/src/auth/` (`discover`, `exchange-code`,
`token-response`, `silent-refresh`, `revoke-token`, `loopback-flow`) move into
`@pagespace/sdk`; the CLI imports them. One implementation of the wire protocol. New registry
operations `auth.me` and `oauthApps.*`, and an `API_CONTRACT_VERSION` minor bump per ADR 0001.

## Decision 12 — Platform-managed clients for env-hosted apps

Every env that hosts an app gets a platform-managed OAuth client, with redirect URIs derived
from the preview host (`env-<id>.preview.<apex>`,
`packages/lib/src/services/sandbox/preview/preview-host.ts`) and the published subdomain
(`published_apps.subdomain`, `packages/db/src/schema/published-apps.ts`). `PAGESPACE_URL` and
`PAGESPACE_CLIENT_ID` are injected into the sandbox and machine env — both public values, so the
no-secrets-in-a-sandbox invariant holds (Decision 1).

## Decision 13 — Remote MCP and the Apps bridge are positioned, not built

`oauth_clients` stays a superset of RFC 7591's metadata, and `registration_endpoint` stays
additive in the discovery document. A client row can carry an entry URL and its granted scopes,
which is what an embedded Apps bridge or a remote MCP host would need. Nothing here is built
this epic. This restates ADR 0002 Decision 4's posture; see the amendment below for what
changes.

## Decision 14 — No new login UI, ever

Third-party apps never render credentials. An unauthenticated user at the authorize endpoint is
sent to PageSpace's own `/auth/signin?next=/oauth/consent…` — `/oauth/consent` is already on
`SIGNIN_NEXT_ALLOWED_PREFIXES` (`apps/web/src/middleware.ts:20,99`), and Google and magic-link
already carry `next` through the round trip. Apple native and passkey get tests in Phase 1.

Every sign-in method PageSpace supports therefore reaches every app for free, including ones
added later. The sign-in page names the requesting app so the user knows why they are there.

## Amendment to ADR 0002 Decision 4 — dynamic client registration

ADR 0002 said registration "does not ship in this epic" and the schema merely accommodates it.
Amended: **registration ships, through the developer console and the `oauthApps.*` operations**
— a first-party authenticated surface, rate-limited like every other endpoint, with a human user
behind it. RFC 7591's `registration_endpoint` (unauthenticated, open) remains deferred and
remains additive; nothing in `validateClientRegistration` presumes which door the metadata came
through, so shipping the RFC endpoint later is a routing change, not a contract change.

Everything ADR 0002 Decision 4 asserted about registered clients still holds: always `public`,
always PKCE, never `firstParty`, scope-capped identically to everyone else.

## Decided (were open at the time of writing)

- **[D-9] — a platform-managed client per env is automatic.** Every env that hosts an app gets
  one; the builder does not create it (Decision 12).
- **[D-10] — the standard callback path is `/auth/pagespace/callback`.** Zero-config apps and
  the SDK's defaults use it; Phase 3 leaf 2 and Phase 4 leaf 3 build on it.
- **[D-11] — `pagespace-cli` may request `profile`.** Decision 4 rejects `profile manage_keys`,
  so the CLI asks for `profile` in the grant where it wants identity, not alongside its
  key-management grant.
- **[D-8] — build order is 0 → 1 → 2 → 3 → 4 → 5 → 6, sequential.**

## Fail-closed posture (each line is a test)

| # | Situation | Behavior |
|---|---|---|
| G1 | `profile` mixed with `account` | Reject, `profile_account_conflict` — never collapsed into either |
| G2 | `profile` mixed with `manage_keys` / `all_drives` / `update_key` / `activate_key` | Reject with the existing conflict shape |
| G3 | `profile drive:*` grant reaching token issuance | Ordinary OAuth pair, never an `mcp_` key (`isPureDriveGrant` excludes it) |
| G4 | A granted `account` used to satisfy a requested `profile`, or the reverse | Not a subset; reject |
| G5 | Third party presents any loopback redirect | Reject — wildcard and exact alike |
| G6 | Redirect with userinfo / query / fragment / `*` / `localhost` / non-loopback `http` | Reject, at registration and at authorize |
| G7 | Registered redirect that is itself dirty (query, fragment, userinfo) | Grants nothing, including through the loopback branch |
| G8 | A private-use registration presented against an https candidate (or the reverse) | Never matches — kinds must agree |
| G9 | `javascript:` / `data:` / `file:` / `blob:` / `about:` / `vbscript:` / `ws(s):` redirect | Never a private-use scheme, registered or not |
| G10 | Registration declaring `account` / `all_drives` / `manage_keys` / key ops / `name:` | Reject, `forbidden_scope` |
| G11 | Registration declaring a concrete `drive:<id>` instead of a shape | Reject — a cap names shapes |
| G12 | Registration with `allowedScopes: []` | Reject — not "no cap" |
| G13 | Non-https `logoUrl` / `homepageUrl` | Reject |
| G14 | Registration body carrying `firstParty` / `verified` / an id | Silently dropped; never read |
| G15 | Untrusted input of any shape into `validateClientRegistration` | Typed errors, never a throw |
| G16 | A new `ScopeSet` field added without a step-up decision | Fails to compile in `step-up-boundary.ts` |
| G17 | Unknown, disabled, or foreign-redirect client | Identical `invalid_client`; no oracle |
| G18 | `name:` on a profile-bearing grant | Reject, `name_without_mint_grant` — the consent screen never promises a key nothing mints |
| G19 | A URL-wrapping or platform-handled scheme (`filesystem:`, `view-source:`, `jar:`, `chrome:`, `content:`, `intent:`, `mailto:`, …) | Never a private-use scheme, registered or not |
| G20 | A client name or description carrying control characters, bidi overrides, directional isolates, zero-width characters, or (for the name) leading/trailing/only whitespace | Reject — both render beside the "Unverified app" badge, and ADR 0002 Decision 5 makes the consent screen part of the security boundary |
| G21 | Two registered redirect URIs that normalize to the same `href` (default port, host case) | Reject as duplicates — the stored list matches what authorize honours |
| G22 | A non-string `allowedScopes` / `redirectUris` entry, including one with a poisoned `toString`/`valueOf` | Typed error with a FIXED placeholder; never coerced, never thrown |

## Pure-function signatures (Phase 0 implements these; Phases 1–4 consume them)

```ts
// packages/lib/src/auth/oauth/scopes.ts — ScopeSet gains one field
type ScopeSet = { /* … */ profile: boolean };
type ScopeError = /* … */ | { code: 'profile_account_conflict' };

// packages/lib/src/auth/oauth/step-up-boundary.ts
function requiresStepUp(scopes: ScopeSet): boolean;

// packages/lib/src/auth/oauth/clients.ts
interface RegisteredClient {
  clientId: string; name: string; type: 'public';
  redirectUris: string[]; allowedGrantTypes: readonly string[];
  firstParty: boolean; verified: boolean;
  logoUrl?: string; homepageUrl?: string; description?: string;
  ownerUserId?: string; allowedScopes?: string[];
}
function validateRedirectUri(
  client: Pick<RegisteredClient, 'redirectUris' | 'firstParty'>,
  redirectUri: string,
): boolean;

// packages/lib/src/auth/oauth/client-registration.ts
function validateClientRegistration(input: unknown):
  | { ok: true; value: ClientRegistration }
  | { ok: false; errors: ClientRegistrationError[] };
```

## Consequences

- ADR 0002's grammar gains a sixth top-level token, `profile` — additive under its own "tokens
  are only ever added, never reinterpreted" rule. Every credential issued before this change
  keeps working exactly as issued. Two existing rules gain a `profile` term (rule 10's
  principal-shape list, rule 13's mint-shape exclusion); both are vacuous for any string written
  before `profile` existed, so this is an extension of those rules rather than a change to them.
- ADR 0002 Decision 3's "loopback only" becomes "loopback only *for first-party clients*", which
  is strictly narrower for everyone who is not the CLI and identical for the CLI. The sixteen
  existing CLI redirect tests pass unchanged.
- ADR 0002 Decision 4's deferral of registration is narrowed to RFC 7591's *endpoint*; the
  metadata contract it anticipated is now real and validated.
- ADR 0003 is untouched. `mcp_` keys remain the non-interactive credential; OAuth tokens remain
  what a signed-in user's app holds. Decision 5 is what keeps those two from blurring.
- `requiresStepUp` makes the consent ceremony a property of the scope set rather than of the
  endpoint. Phase 1 must not reintroduce an endpoint-level "always step up" branch beside it.
- The step-up map's `satisfies` clause means every future scope addition is a two-file change:
  the grammar, and an explicit statement of whether it can be approved without a second factor.
  That is the intended friction.
