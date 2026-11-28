# Agent Signup — Threat Model

- **Scope:** the two agent signup doors (API/auth.md and browser), the agent secret, the claim ceremony, and the billing link to a human owner. Contract: ADR 0008 (`docs/adr/0008-agent-identities.md`).
- **Date:** 2026-09-14 (Phase 0). Revised when [D-31] is answered (§6), and on 2026-11-28 by the security review addendum (ADR 0008 §7): the claim token is retired, the claim grant mints nothing, `lastAuthAt` follows every authentication, signup buckets IPv6 by /48, and the key-mint caps follow the caller.
- **Posture:** zero trust as everywhere else in this repo — fail closed, opaque tokens hashed at rest, constant-shape errors, rate-limit every new endpoint, a control must reach where the effect lives.

## 1. Principals

| Principal | What it holds | What it can do |
|---|---|---|
| **Anonymous IP** | Nothing. | Fetch metadata and `/auth.md`; request a PoW challenge; attempt signup (PoW + rate limits); attempt sign-in with a guessed secret (rate-limited, constant 401). It cannot start, poll or approve a claim: there is no claim token, and both claim doors take only the agent's own credential. |
| **Unclaimed agent** | Its own `ps_agent_*` secret; the `ps_at_`/`ps_rt_` tokens it exchanged for; any `mcp_` keys it minted. Nothing else — no claim token exists. | Everything a free-tier user can do that costs nothing: drives, pages, keys, OAuth grants, API/CLI/MCP. **No AI spend** (402 `requires_funding`). Whether it can DM, invite or upload is [D-31] (§6). |
| **Claimed agent** | The same credentials (pre-claim tokens survive the claim). | Everything above, plus AI calls billed to its owner at the owner's tier. |
| **Owner (human)** | A normal human account, signed in. | Claim an agent by the user code the agent handed it; list, rotate, revoke or unlink the agents it owns; pays for their AI usage. Never receives the agent's tokens from a claim. After an unlink it holds nothing that can start, poll or approve a claim for that agent. |
| **Server** | Hashes only: `secretHash`, `userCodeHash`, `challengeHash`. | Never holds a plaintext secret after the signup response is sent. |

## 2. Assets

1. The agent secret (`ps_agent_*`) — full control of the agent account.
2. *(Retired.)* There is no claim token: starting and polling a claim is a right of the agent's own credential (ADR 0008 §7.1).
3. The user code — the right to *finish* a claim, for 15 minutes, by a signed-in human — and so to become the agent's owner, who pays and may rotate or revoke it.
4. The owner link (`agent_identities.ownerUserId`) — routes AI spend to a human's balance.
5. The human's credit balance once linked.
6. Rows and storage (the only thing an unfunded agent can consume).
7. Humans' attention: DMs, invites, uploads from an entity nobody vouched for.

## 3. Plaintext residency of the secret

The secret exists in plaintext in exactly two places, and nowhere else:

1. **The signup response** (`POST /api/agent/identity` or `POST /api/auth/agent/signup`) — the one time the server ever returns it. It is not logged, not audited in `details`, and not echoed by any later endpoint. Rotation returns a *new* secret the same way, once.
2. **The agent's own store** — wherever the agent chose to keep it (a credential file, an env var, a keychain). This is outside PageSpace's control.

At rest the server stores `hashToken(secret)` (SHA3-256) and a 12-character prefix for support identification. Sign-in and the jwt-bearer exchange look up by hash; there is no plaintext fallback and no KDF (`secure-compare.ts` rule: hash-then-compare).

## 4. Non-guarantees — what this design deliberately does not promise

1. **A shared secret can be copied by anyone who reads the agent's store.** There is no device binding, no passkey, no vendor attestation. Whoever holds the secret *is* the agent. The founder accepted this on 2026-09-14: isolating agents into their own accounts is precisely what bounds the blast radius — a copied agent secret never grants access to a human's account, only to the agent's own drives and, once claimed, to spend against its owner's balance. Mitigations are rotation (by the agent or its owner), revocation (bumps `tokenVersion`, live tokens die), and the owner's per-agent visibility in Settings.
2. **Proof-of-work shapes rate; it does not identify.** A 20-bit SHA3-256 puzzle costs a well-provisioned attacker fractions of a second. PoW exists to make bulk account creation cost CPU rather than nothing. The per-IP limits (`AGENT_CHALLENGE`, `AGENT_SIGNUP`, `AGENT_SIGNUP_DAILY`) shape each caller, but an IP is only as trustworthy as the proxy that reports it; the real ceiling is the deployment-wide budget `AGENT_SIGNUP_GLOBAL_BUDGET` (Phase 2b: at most N agent accounts per rolling hour across every door, counted from rows actually created, under an advisory lock). Its shape is an open founder decision (D-37). PoW says nothing about *who* or *what* is signing up, and nothing here depends on it doing so.
3. **The verification link is a grant of ownership, and only the agent can mint one.** Only the agent itself, with its own access token or browser session, can start a claim (`decideClaimCaller`), and only it can poll the result, which mints no token. The link it hands a human (`verification_uri_complete`: a user code, short-lived, hashed at rest, single-use, superseded by the agent's next start, denied by an unlink) lets whoever approves it from a `human` session become the owner — who pays for the agent and, by Decision 14, may rotate its secret or revoke it. So the link must go only to the intended owner (`/auth.md` says so), and the agent learns who approved from its poll and `/api/auth/me`. What a leaked link can no longer do: hand anyone the agent's tokens through the claim, or be replayed by a former owner after an unlink. *(Before the security review, a claim token anyone could hold started claims, and the claim poll minted the agent's tokens for whoever polled — a full takeover; ADR 0008 §7.1.)*
4. **No free credits means no free spend — but not no cost.** An unfunded agent can still create rows and upload within the free-tier storage quota. Rate limits and the 30-day lifecycle for never-authenticated signups ([D-30]) bound this; they do not eliminate it.
5. **The reserved domain is a convention enforced in code, not a network property.** `agents.pagespace.invalid` cannot resolve (RFC 2606), but its safety inside PageSpace depends on the five inbound denylist sites and the one outbound suppression point staying in place. Those are mutation-checked and enumerated by a test (ADR 0008 §4).

## 5. Threats and controls

| # | Threat | Control | Where it lives |
|---|---|---|---|
| T1 | Bulk account creation (row/storage exhaustion, spam identities). | PoW challenge (single-use, 5-minute TTL, server-issued, consumed atomically); `AGENT_SIGNUP` 5/60min/IP and `AGENT_SIGNUP_DAILY` 10/24h/IP (IPv6 bucketed by /48 on the account-creating doors; off Fly the IP is trusted only under `TRUSTED_PROXY_HOPS`); the deployment-wide `AGENT_SIGNUP_GLOBAL_BUDGET` (default 100 per rolling hour, enforced inside `createAgentAccount`, refused with the same 429 as a per-IP limit, per-IP attempts refunded); free-tier storage quota; 30-day lifecycle for never-authenticated signups, swept hourly. | `pow.ts`, `decideAgentSignup`, `decideAgentSignupBudget`, rate limits, `decideAgentLifecycle`. |
| T2 | Challenge replay / precomputation. | Challenge is random, hashed at rest, bound to `expiresAt`, consumed on first use (`UPDATE … WHERE consumedAt IS NULL RETURNING`); a consumed or expired challenge is `challenge_invalid`. | `decideAgentSignup`, Phase 1 service. |
| T3 | Secret guessing / credential stuffing on the sign-in door. | 32-character CSPRNG-seeded CUID2 body (≈ 165 bits); shape check before any lookup; lookup by SHA3-256 hash; `AGENT_SIGNIN` = `LOGIN` limits; lockout increments on failure; **constant-shape 401** — unknown, revoked, suspended and locked all look identical on the wire. | `isAgentSecretShape`, `decideAgentSignin` (typed internally, one reason on the wire). |
| T4 | Agent secret presented to the wrong grant / client. | jwt-bearer and the claim grant are allowed only for `client_id=pagespace-agent`; `pagespace-cli` keeps its existing grants; `drive:*`, `all_drives` and key-shaped scopes are refused on the assertion grant. | `clients.ts`, token route (Phase 2). |
| T5 | Reserved domain entering a human auth flow (an attacker registers `agent-x@agents.pagespace.invalid` by magic link and inherits an agent's identity via the email unique index). | The five-site inbound denylist with the ordinary "invalid email" issue (no oracle); the `users.email` unique constraint means the synthetic address is minted only by the agent-account service. | `notAgentReservedEmail`, Phase 1 sites. |
| T6 | Mail sent to the reserved domain (bounces, provider reputation, information leak in bounce bodies). | Outbound choke point no-ops for the domain. | `email-service.ts` (Phase 1). |
| T7 | A non-human "claims" an agent (an agent claiming an agent to chain billing, or an agent claiming itself). | `decideClaimApproval` denies any claimer whose `accountType !== 'human'` before every other check; mutation-checked. | `claim-decision.ts`. |
| T8 | Double claim / claim race. | `already_claimed` when `ownerUserId` is set; approval sets owner and `claimedAt` in one transaction; a settled claim record stays settled; a new start supersedes every open claim. | `decideClaimApproval`, Phase 4 service. |
| T9 | Claim-poll hammering. | RFC 8628 vocabulary: `slow_down` when polled faster than `pollIntervalSeconds`; `OAUTH_DEVICE_POLL` limits reused, per IP before authentication and per agent after. | `decideClaimPoll`. |
| T10 | Agent spends without funding (the $5 starter grant). | `starterGrantCents` is 0 for agents at **both** lazy branches; no `free-init-<agentId>` ledger row can exist; `requires_funding` → 402 with `claim_url`. Mutation-checked. | `credit-pricing.ts`, `credit-gate.ts` (Phase 1). |
| T11 | Owner charged after unlinking, or agent keeps spending after revoke. | `resolveBillingPayer` is evaluated at each of the three seams per call, never cached; revoke bumps `tokenVersion` so live tokens die. | `agent-payer.ts`, Phase 4. |
| T12 | Agent obtains a Stripe customer / subscription with an undeliverable address. | `api/stripe/customer` refuses `accountType === 'agent'`. | Phase 1. |
| T13 | Deployment where the door should not exist (onprem without opt-in). | `isAgentSignupEnabled` is the single predicate; disabled ⇒ routes and page 404; `decideAgentSignup` reports `disabled` before revealing any challenge state. | `enabled.ts`, `signup-decision.ts`. |
| T14 | Issuer / URL injection into discovery documents. | `buildServerMetadata` and `buildAuthMd` derive every URL from the configured issuer only, never a request `Host`. | `metadata.ts`, `auth-md.ts`. |
| T15 | Credential hashes reaching logs through a failed query (drizzle's `DrizzleQueryError` message is the query plus its bound params). | `redactDbError` everywhere a query error is logged on these paths (identity service, token endpoint, mcp-token mint, rate limiter); `AgentIdentityStoreError` carries no cause; the credential rate-limit bucket key is a truncated, domain-separated digest, never the stored hash. | `db-error-redaction.ts`, `agent-identities.ts`, `token-rate-limit-keys.ts` (Phase 2b). |
| T16 | Impersonation / prompt injection through an agent's self-chosen display name. | A marker derived from `accountType` (never parsed from the name): `AgentBadge` on member, chat, picker, share, invite and presence surfaces; `modelContextUserLabel` (labelled, JSON-quoted, invisible characters escaped) in model context; `withAgentMarker` in invite emails. Remaining informational surfaces: leaf 6b. | `display-name.ts`, `AgentBadge.tsx` (Phase 2b). |
| T17 | Agent takeover through the claim (a holder of a claim credential, a throwaway approver, or a former owner obtains the agent's tokens or re-claims it). | No claim token exists; both claim doors and the claim grant accept only the agent's own credential (`agent_grant_token` Bearer, or its session) — `decideClaimCaller`; the claim grant answers `{claimed, owner}` and mints no token; a `claim_token` parameter is refused; unlink returns nothing secret and denies every open claim; a start supersedes older codes. Regression-tested as the full exploit chain. | `caller-policy.ts`, `claim-start-handler.ts`, token route claim grant, `agent-claim-repository.ts`, `agent-ownership.ts` (security review). |
| T18 | An agent in active use erased as abandoned. | `lastAuthAt` is stamped on every authentication: secret check, jwt-bearer exchange, every browser session start (signup and sign-in), every refresh of the agent's tokens (`recordAgentAuthentication`). | `agent-identities.ts`, `browser-session.ts`, `refreshTokenGrant` (security review). |
| T19 | One site starves the signup budget, or junk outruns the sweep. | The account-creating doors bucket IPv6 by /48 (`agentSignupRateLimitAddress`); the lifecycle sweep runs hourly and drains keyset-paged batches up to 500 erasures or 5 minutes a run. | `token-rate-limit-keys.ts`, `agent-lifecycle.ts`, `docker/cron/crontab` (security review). |
| T20 | A cookie-signed-in agent stockpiles keys. | `AGENT_KEY_MINT` and the 20-live-key cap apply to every caller whose `accountType` is `agent`, whatever its credential (`decideAgentKeyMint`; unreadable account type fails closed). | `caller-policy.ts`, `api/auth/mcp-tokens` (security review). |

## 6. Unclaimed agents reaching humans — pending D-31

**pending D-31.** The decision whether an unclaimed agent may initiate DMs, invitations and uploads is open on the global Decisions list (D-31). It is implemented through exactly one mechanism — when `emailVerified` is stamped on the agent's `users` row (at signup, or at claim) — because the seven `isEmailVerified` gates and four `isNotNull(emailVerified)` filters already enforce it. No gate is edited either way. When the orchestrator posts the answer in the epic channel, this section is replaced by its one-sentence consequence for unclaimed agents, and Phase 1 stamps accordingly.

## 7. Residual risk accepted

- Secret theft from the agent's own environment (§4.1).
- CPU-rich attackers paying the PoW cost and staying under the per-IP limits across many IPs (§4.2); the cost to us is rows, not money.
- A stranger becoming an agent's owner via a verification link the agent itself handed out and that leaked within its 15 minutes (§4.3): that owner pays, and may rotate or revoke the agent. Mitigated by the link being short-lived, single-use and superseded by the agent's next claim; the agent sees who its owner is. The claim no longer hands anyone the agent's tokens.
- An owner who rotated the agent's secret has seen it; an unlink does not take that knowledge back. The agent should rotate its secret after an unlink if its owner ever rotated it.
