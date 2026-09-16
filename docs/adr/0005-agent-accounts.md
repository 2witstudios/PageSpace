# ADR 0005 — Agent Accounts

- **Status:** Proposed (Phase 0 contract — freezes the account, credential, billing and door model Phases 1–5 implement)
- **Date:** 2026-09-14
- **Deciders:** Agent Signup epic (epic page `q6nb94aq0ymvfslr11nqobjr`, Phase 0 page `cvdqaj2ldht937yyqumv2tgg`); founder decisions taken with Jono 2026-09-14
- **Related:** ADR 0002 (scope grammar & client model — this ADR adds one static client and **no new scope shapes**; nothing in ADR 0002 is amended), ADR 0003 (CLI credential model — the tokens an agent ends up holding are exactly the `ps_at_*`/`ps_rt_*` pair ADR 0003 defines). Sibling epics: *Sign in with PageSpace* (`yv08hib74nrtmksdzxmf5nkw`, DB-backed OAuth clients) and *Agent Accounts & Credential Broker* (`j471yhv7p3abea7mlxrchdu1`, PageSpace agents holding credentials for other sites). This ADR is the mirror of the latter: PageSpace becomes a site where an agent can hold its own account.
- **Threat model:** `docs/security/agent-signup-threat-model.md`.

## Question

How does an AI agent (Claude Code, Codex, a ChatGPT agent, a browser/computer-use agent) get a PageSpace account of its own — no email address, no human in the loop — without weakening zero trust, without handing out free AI spend, and without touching the sign-in path existing users rely on?

Two shapes were live:

- **(a)** A new principal kind beside `users` (an "agents" table with its own auth, permissions and ownership model).
- **(b)** An agent **is a `users` row**, discriminated by one column, holding one opaque secret, with a claim ceremony that later links a paying human.

## Decision (summary)

**Option (b).** An agent is a real `users` row from the moment it signs up: every permission check, drive, page, key, OAuth grant and SDK/CLI/MCP path works unchanged. What is added is (1) a discriminator `users.accountType`, (2) a credential an agent can hold — an opaque `ps_agent_*` secret hashed SHA3-256 at rest, (3) exclusion from the lazy $5 starter grant, (4) two doors (an auth.md-compatible API door and a browser door on the existing auth pages), and (5) a claim ceremony that sets an owner and routes the agent's AI spend to that owner. **Agents get no free AI credits; the claim is the upgrade path.** Every decision below is a pure function frozen in Phase 0; Phases 1–5 write only adapters.

Everything below is the verified ground truth, the fourteen decisions with their reasoning, the exact contracts, and the numbered assertions later phases turn into tests.

---

## 1. Ground truth (verified 2026-09-14 on master `a6784a23b`)

- **No password stack.** No argon2/bcrypt anywhere; `packages/lib/src/auth/secure-compare.ts` rejects KDFs by design. The house pattern is `generateToken(prefix)` + `hashToken` (SHA3-256) in `packages/lib/src/auth/token-utils.ts`, with prefixes `ps_magic_`, `ps_dc_`, `ps_at_`, `ps_rt_`, `mcp_`.
- **Every signup door is email-shaped.** Magic link (`api/auth/magic-link/send` → `requestMagicLink` → `createUserAccount`), passkey keyed on email (`api/auth/signup-passkey`), Google/Apple. `users.email` is unique NOT NULL with a blind index; `emailVerified` is nullable; `provider` is `email|google|apple`; there is **no `accountType`**.
- **A system principal already uses an RFC 2606 `.invalid` address** (`system@pagespace.invalid`, `packages/lib/src/services/validated-service-token.ts`) precisely so it can never be delivered to or registered through any external auth flow.
- **Email is load-bearing in seven gates and four filters.** `isEmailVerified` guards DMs, invites, connections, share-invites and attachment upload; `isNotNull(users.emailVerified)` filters user search, visibility and broadcast audience. `/api/auth/me` returns `email: string` and the CLI's `confirm-identity.ts` zod requires it.
- **Credits are granted lazily.** `canConsumeAI` seeds the free-tier starter grant at two branches (no row; bare row) via `starterGrantLedgerRow` keyed `free-init-<userId>`, amount `TIER_MONTHLY_ALLOWANCE_CENTS.free = 500`. `consumeCredits` / `releaseHold` settle. Thirteen gate callers all pass through `credit-gate-response.ts`. `sandbox-payer.ts` is the pay-for-someone-else precedent. `isBillingEnabled() === isCloud()` and billing-off returns `unlimited`.
- **OAuth provider.** Static client registry (`packages/lib/src/auth/oauth/clients.ts`, only `pagespace-cli`; the Sign-in epic is converting it to DB-backed lookup — edits must stay additive); RFC 8414 metadata built purely from the issuer (`metadata.ts`); pure device-code decisions (`code-lifecycle.ts`: `decideDevicePoll`, `decideDeviceApproval`); user codes (`user-code.ts`); `issueInitialTokenPair` in the web repository.
- **Protocol.** auth.md (WorkOS, verified against the spec and Neon's production implementation): `agent_auth { skill, identity_endpoint, claim_endpoint, identity_types_supported }` in RFC 8414 metadata; `POST identity {type:'anonymous'}` → `identity_assertion` + `claim_token`; exchange with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…`; claim → `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`; poll with a claim grant. Cloudflare temporary accounts gate creation with proof-of-work plus rate limits. **No vendor-verifiable agent identity exists** for Claude Code or Codex; nothing here depends on one.

## 2. Decisions (locked unless a [D-n] reopens them)

| # | Decision | Why |
|---|---|---|
| 1 | `users.accountType` pgEnum `('human','agent')`, default `'human'`, NOT NULL. | One discriminator readable wherever `users` is already selected. Nothing today can tell a bot from a human (the system users are hard-coded ids). Default `'human'` makes the migration a no-op for every existing row. |
| 2 | Synthetic email `agent-<userId>@agents.pagespace.invalid`. The domain is **denied in every inbound auth path** and **suppressed at the outbound choke point**. *When* `emailVerified` is stamped (at signup vs at claim) is **[D-31]**; recommended: at claim, so an unclaimed agent can hold content but cannot reach humans. | Keeps `email: string` across ~11 SDK/CLI zod contracts and the seven gates / four filters. RFC 2606 guarantees the domain can never resolve or receive mail. Making `email` nullable is a strict superset of this work. |
| 3 | New tables `agent_accounts`, `agent_claims`, `agent_signup_challenges`; `oauth_device_codes` is **not** reused for claims. | Device rows bind human→client and `pollDeviceToken` mints for the *approving human*; a claim binds human→agent and mints for the *agent*. Only the pure pieces (`user-code.ts`, the poll/approval decision shape, the `/activate` UI) are reused. |
| 4 | The `identity_assertion` **is** the opaque secret `ps_agent_…` (Neon's durable-secret model), SHA3-256 at rest via `hashToken`. No JWT. | No JWS stack exists; the assertion is only ever presented to our own token endpoint; rotation = a new secret. Hash-then-compare, no KDF, per `secure-compare.ts`. |
| 5 | Exchange: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<secret>`, `client_id=pagespace-agent` — a new **static public client** whose allowed grants are jwt-bearer, the claim grant and `refresh_token`, with no redirect URIs and **`firstParty: false`**. | Generic auth.md clients send the RFC 7523 URN. A separate client id keeps agent grants out of `pagespace-cli`'s allowed grants and separates audit and rate-limit keys. `firstParty` unlocks `applyKeyGrant` (an `mcp_` key minted on a drive grant) and the loopback redirect wildcard; this client never uses the authorize or device flows and refuses drive scopes, so least privilege says false. The registry edit is one additive object. |
| 6 | Exchange mints the standard `ps_at_`/`ps_rt_` pair via `issueInitialTokenPair`; default scope `account offline_access`; `drive:*`, `all_drives` and key-shaped scopes are refused on this grant. Agents mint `mcp_` keys through the existing `manage_keys` paths. | `/api/auth/me` and every `allow:['oauth']` route already accept `ps_at_`; `mcp_` remains the headless content credential. ADR 0002's grammar is untouched. |
| 7 | **Pre-claim tokens survive the claim.** | The principal does not change (the agent stays the agent); the claim only adds an owner link. Neon revokes because anon→user is a principal change there; here it is not. |
| 8 | **Owner pays.** `resolveBillingPayer({userId, ownerUserId})` names the owner when set and the owner's tier applies; wired at the three billing seams `canConsumeAI`, `consumeCredits`, `releaseHold`. Agents are refused at `api/stripe/customer`. | Precedent `sandbox-payer.ts`. One seam at the billing entry points instead of thirteen gate callers; no gifting ledger; a Stripe customer needs an email that can receive invoices. |
| 9 | **No starter grant for agents.** Pure `starterGrantCents({tier, accountType})` used by **both** lazy branches; a `credit_balances` row is still created (the gate needs a row to lock); new `GateReason 'requires_funding'` → 402 with `claim_url`, derived by pure `refineGateReason`. | Load-bearing and mutation-tested. Agents see a reason pointing at the claim path, not the human "add credits" copy. `evaluateGate` itself is unchanged. |
| 10 | **Proof-of-work** on both doors: SHA3-256 leading-zero-bits over `challenge:nonce`, server-issued single-use 5-minute challenge, `AGENT_SIGNUP_POW_BITS` default 20; plus `AGENT_CHALLENGE`, `AGENT_SIGNUP`, `AGENT_SIGNUP_DAILY`, `AGENT_SIGNIN`, `AGENT_CLAIM_INIT` rate limits. **No Turnstile.** | A captcha would block the very users we want. With zero credits the abuse surface is rows and storage only; PoW shapes rate, rate limits cap it. |
| 11 | **Deployment mode:** cloud + tenant enabled; onprem only with `AGENT_SIGNUP_ENABLED=true` (exactly). Disabled ⇒ routes and the page 404. | Onprem has billing off (`canConsumeAI` returns `unlimited`), so an operator opts in knowingly. Tenant is a normal cloud topology and must not be gated out. |
| 12 | `/auth.md` is served by the web app through the well-known rewrite list; `agent_auth` is added to `buildServerMetadata`; `buildAuthMd({issuer})` is asserted to contain every URL in that block. Deploy must verify Caddy passes `/auth.md` to web. | Same mechanism as `/.well-known/oauth-authorization-server`; a test pins the two documents together so they cannot drift. |
| 13 | **Lifecycle** (**[D-30]**, recommended): an unclaimed agent that never authenticated after signup is deleted after 30 days; an agent that ever signed in has no TTL. | Abandoned signups are not entities yet; real agents are. |
| 14 | **Secret rotation** by the agent itself or its owner; an optional `tokenVersion` bump revokes live tokens. Revoking an agent bumps `tokenVersion` so live tokens die. | A control must reach where the effect lives: revoke means tokens actually stop working, not just a flag. |

## 3. Contracts — the pure decision functions (Phase 0 deliverable)

Every decision is a side-effect-free function of plain values; randomness, the clock and every lookup are injected. Phases 1–5 write adapters (routes, repositories, UI, CLI) that call these and persist what the decision implies. Reviewers reject inline decision logic in routes and components.

`packages/lib/src/auth/agent/`

```ts
// reserved-email.ts — Decision 2
export const AGENT_EMAIL_DOMAIN = 'agents.pagespace.invalid';
export function agentSyntheticEmail(userId: string): string;      // agent-<userId>@agents.pagespace.invalid
export function isAgentReservedEmail(email: string): boolean;     // suffix match after normalizeEmail; NOT pagespace.invalid / pagespace.local
export const notAgentReservedEmail: (email: string) => boolean;   // zod refinement; refuses with the ordinary "invalid email" issue

// secret.ts — Decision 4
export function mintAgentSecret(): { secret: string; hash: string; prefix: string }; // generateToken('ps_agent')
export function isAgentSecretShape(value: string): boolean;       // exactly `ps_agent_` + 32 lowercase alphanumerics

// enabled.ts — Decision 11
export function isAgentSignupEnabled(input: { deploymentMode: DeploymentMode; envFlag: string | undefined }): boolean;

// pow.ts — Decision 10
export const POW_DIFFICULTY_BITS: number;                         // envInt('AGENT_SIGNUP_POW_BITS', 20)
export const POW_TTL_MS = 5 * 60 * 1000;
export function verifyPowSolution(input: { challenge: string; nonce: string; difficultyBits: number }): boolean; // total, never throws
export function solvePow(challenge: string, difficultyBits: number): string;  // test/CLI helper

// signup-decision.ts / signin-decision.ts / claim-decision.ts — Decisions 3, 5, 7, 8
export function decideAgentSignup(input): { status: 'ok' } | { status: 'disabled' | 'challenge_invalid' | 'pow_invalid' | 'tos_required' };
export function decideAgentSignin(input): { status: 'ok' } | { status: 'not_found' | 'revoked' | 'suspended' | 'locked' };   // one wire reason
export function decideClaimPoll(record, now): authorization_pending | slow_down | expired_token | access_denied | already_redeemed | ok(grant);
export function decideClaimApproval(record, action, claimer, now): approved | denied | not_human | already_claimed | already_settled | expired;

// lifecycle-decision.ts — Decision 13
export function decideAgentLifecycle(row: { ownerUserId; lastAuthAt; createdAt }, now: Date): { action: 'keep' | 'delete' };
```

`packages/lib/src/billing/`

```ts
// credit-pricing.ts — Decision 9
export function starterGrantCents(input: { tier: string; accountType: 'human' | 'agent' }): number; // 0 for agent
// credit-core.ts — Decision 9
export type GateReason = … | 'requires_funding';
export function refineGateReason(input: { reason: GateReason; accountType; hasOwner: boolean }): GateReason; // out_of_credits → requires_funding for an unclaimed agent
// agent-payer.ts — Decision 8
export function resolveBillingPayer(input: { userId: string; ownerUserId: string | null }): { payerId: string; viaAgentOwner: boolean };
```

`packages/lib/src/auth/oauth/` and `apps/web/src/lib/agent-auth/`

```ts
// metadata.ts — Decision 12
buildServerMetadata({ issuer }).agent_auth: { skill, identity_endpoint, claim_endpoint, challenge_endpoint,
  identity_types_supported: ['anonymous'], assertion_grant_type, claim_grant_type };
// clients.ts — Decision 5
getRegisteredClient('pagespace-agent'): public, allowedGrantTypes = [jwt-bearer, claim, refresh_token], redirectUris = [];
// auth-md.ts — Decision 12
export function buildAuthMd({ issuer }): string; // Discover → Prove work → Register → Exchange → Use → Fund → Rotate/Revoke → Limits
```

## 4. The five reserved-domain inbound sites and the three billing seams

**Inbound denylist (Decision 2).** The shared refinement `notAgentReservedEmail` must be applied at exactly these five sites, and a test enumerates them (pattern of `api/__tests__/security-audit-coverage.test.ts`):

1. `api/auth/magic-link/send` (or the `requestMagicLink` pipe it calls).
2. `api/auth/signup-passkey/options`.
3. `packages/lib/src/auth/oauth-account-match.ts` (Google/Apple account matching).
4. `apps/admin/src/app/api/admin/users/create/route.ts`.
5. `api/account/route.ts` (email change).

**Outbound choke point.** `packages/lib/src/services/email-service.ts` early-returns for `isAgentReservedEmail(options.to)` beside the existing `isOnPrem()` return.

**Billing seams (Decision 8).** `resolveBillingPayer` is consulted at exactly three places, and nowhere else: `canConsumeAI` (credit-gate.ts), `consumeCredits` and `releaseHold` (credit-consume.ts). The thirteen gate callers are untouched.

## 5. Testable assertions (each becomes a RED test in Phase 0 or the phase named)

1. `isAgentReservedEmail('Agent-x@AGENTS.pagespace.invalid ')` is true; `isAgentReservedEmail('system@pagespace.invalid')`, `('x@pagespace.local')`, `('x@agents.pagespace.invalid.evil.com')` are false. *(Phase 0, mutation-checked.)*
2. `agentSyntheticEmail(a) !== agentSyntheticEmail(b)` for `a !== b`, and every synthetic email satisfies `isAgentReservedEmail`. *(Phase 0.)*
3. A zod email schema refined with `notAgentReservedEmail` rejects a reserved address with the same issue shape as a malformed address (no distinct oracle). *(Phase 0.)*
4. `mintAgentSecret()` returns a secret matching `isAgentSecretShape`, `hash === hashToken(secret)`, and two calls never collide. *(Phase 0.)*
5. `isAgentSignupEnabled` is true for `cloud` and `tenant` regardless of the flag, and for `onprem` iff `envFlag === 'true'` (not `'TRUE'`, `'1'`, `'yes'`). *(Phase 0.)*
6. `verifyPowSolution` accepts a nonce whose SHA3-256(`challenge:nonce`) has exactly `difficultyBits` leading zero bits and rejects one with `difficultyBits - 1`; rejects `difficultyBits ≤ 0`, `> 64`, a non-ASCII nonce and an over-long nonce; never throws. *(Phase 0, comparison mutation-checked.)*
7. `decideAgentSignup` reports `disabled` before any challenge state, `challenge_invalid` before `pow_invalid`, `pow_invalid` before `tos_required`. *(Phase 0.)*
8. `decideAgentSignin` returns `ok` only when the account is found and none of `revokedAt`, `suspendedAt`, `lockedUntil > now` apply; a lock expiring exactly at `now` is not a lock. *(Phase 0.)*
9. `decideClaimPoll` returns `slow_down` only for a pending record polled strictly faster than `pollIntervalSeconds`; a settled record reports its outcome regardless of throttle; expiry is checked before settlement. *(Phase 0.)*
10. `decideClaimApproval` denies a claimer whose `accountType !== 'human'` before every other check, and returns `already_claimed` when the agent already has an owner. *(Phase 0, human-only rule mutation-checked.)*
11. `starterGrantCents({tier:'free', accountType:'agent'}) === 0` and `starterGrantCents({tier:'free', accountType:'human'}) === TIER_MONTHLY_ALLOWANCE_CENTS.free`; an unknown tier for a human falls back to the free allowance. *(Phase 0, mutation-checked.)*
12. After an agent's first `canConsumeAI`, a `credit_balances` row exists, no `free-init-<agentId>` ledger row exists, and the gate returns `requires_funding`; a human on the same path gets the ledger row. Both lazy branches are checked separately so flipping the predicate fails both. *(Phase 1.)*
13. `refineGateReason({reason:'out_of_credits', accountType:'agent', hasOwner:false})` is `requires_funding`; the same for a human, or for a claimed agent, is unchanged; every other reason passes through. *(Phase 0.)*
14. `resolveBillingPayer({userId:'a', ownerUserId:'h'})` is `{payerId:'h', viaAgentOwner:true}`; with `ownerUserId: null` it is `{payerId:'a', viaAgentOwner:false}`. *(Phase 0.)* The three seams in §4 each call it and the owner's tier is applied. *(Phase 4.)*
15. `decideAgentLifecycle` returns `delete` iff `ownerUserId === null && lastAuthAt === null && now - createdAt ≥ 30 days`; exactly 30 days deletes; one millisecond short keeps. *(Phase 0.)*
16. `buildServerMetadata({issuer}).agent_auth` contains only absolute URLs under the issuer, `identity_types_supported` is `['anonymous']`, and `grant_types_supported` contains both `urn:ietf:params:oauth:grant-type:jwt-bearer` and `urn:pagespace:agent-auth:grant-type:claim`. *(Phase 0.)*
17. `buildAuthMd({issuer})` contains every URL in `agent_auth` plus `token_endpoint` and `revocation_endpoint`, asserted by iterating over the metadata object so a new endpoint cannot be added without appearing in the document. *(Phase 0.)*
18. `getRegisteredClient('pagespace-agent')` is public, `allowedGrantTypes` is exactly `[jwt-bearer, claim, refresh_token]`, `redirectUris` is `[]`; `getRegisteredClient('pagespace-cli')` is byte-for-byte unchanged. *(Phase 0.)*
19. The five inbound sites in §4 reject a reserved address with a constant-shape error; a test enumerates the five files and fails if one is missing the refinement. *(Phase 1, mutation-checked.)*
20. `sendEmail({to: agentSyntheticEmail(id)})` is a no-op that sends nothing. *(Phase 1.)*
21. `POST /api/stripe/customer` as an agent is refused. *(Phase 1.)*
22. A claim approval sets `ownerUserId`, `claimedAt`, nulls `claimTokenHash` in one transaction, and the agent's pre-claim `ps_at_`/`ps_rt_` tokens still validate afterwards. *(Phase 4.)*
23. Revoking an agent bumps `tokenVersion`; a `ps_at_` issued before the revoke returns 401 afterwards. *(Phase 4.)*
24. `pagespace login`, `pagespace keys`, MCP tokens and both sign-in pages behave identically before and after this epic: `single-auth-path.test.ts`, SDK facade completeness, `hardening.test.ts` and `security-audit-coverage.test.ts` stay green. *(Every phase.)*

## 6. Consequences

- `users` gains one NOT NULL column with a default; the migration is additive and rewrites no existing row. Three new tables are greenfield.
- The OAuth token endpoint gains two grant types, both scoped to `client_id=pagespace-agent`; `pagespace-cli`'s allowed grants are unchanged, so the CLI cannot present an agent secret and an agent cannot use the CLI's device grant.
- Every place that reads `users.email` keeps working; the only behavioural change for the reserved domain is that mail to it is dropped and auth flows refuse it.
- Billing gains one seam (`resolveBillingPayer`) at three call sites and one new gate reason. `evaluateGate` and the thirteen callers are untouched.
- Whether an unclaimed agent can DM, invite or upload is decided by **[D-31]** through the single `emailVerified` stamp; no gate is edited either way.
- If [D-30] is answered differently, only `decideAgentLifecycle` and its test change.
