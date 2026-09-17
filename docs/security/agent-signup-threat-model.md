# Agent Signup — Threat Model

- **Scope:** the two agent signup doors (API/auth.md and browser), the agent secret, the claim ceremony, and the billing link to a human owner. Contract: ADR 0007 (`docs/adr/0007-agent-identities.md`).
- **Date:** 2026-09-14 (Phase 0). Revised when [D-31] is answered (§6).
- **Posture:** zero trust as everywhere else in this repo — fail closed, opaque tokens hashed at rest, constant-shape errors, rate-limit every new endpoint, a control must reach where the effect lives.

## 1. Principals

| Principal | What it holds | What it can do |
|---|---|---|
| **Anonymous IP** | Nothing. | Fetch metadata and `/auth.md`; request a PoW challenge; attempt signup (PoW + rate limits); attempt sign-in with a guessed secret (rate-limited, constant 401); start a claim from a claim token it somehow holds. |
| **Unclaimed agent** | Its own `ps_agent_*` secret; the `ps_at_`/`ps_rt_` tokens it exchanged for; any `mcp_` keys it minted; its claim token. | Everything a free-tier user can do that costs nothing: drives, pages, keys, OAuth grants, API/CLI/MCP. **No AI spend** (402 `requires_funding`). Whether it can DM, invite or upload is [D-31] (§6). |
| **Claimed agent** | The same credentials (pre-claim tokens survive the claim). | Everything above, plus AI calls billed to its owner at the owner's tier. |
| **Owner (human)** | A normal human account, signed in. | Claim an agent by user code; list, rotate, revoke or unlink the agents it owns; pays for their AI usage. |
| **Server** | Hashes only: `secretHash`, `claimTokenHash`, `userCodeHash`, `challengeHash`. | Never holds a plaintext secret after the signup response is sent. |

## 2. Assets

1. The agent secret (`ps_agent_*`) — full control of the agent account.
2. The claim token — the right to *start* a claim for that agent.
3. The user code — the right to *finish* a claim, for 15 minutes, by a signed-in human.
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
2. **Proof-of-work shapes rate; it does not identify.** A 20-bit SHA3-256 puzzle costs a well-provisioned attacker fractions of a second. PoW exists to make bulk account creation cost CPU rather than nothing, and to let the per-IP limits (`AGENT_CHALLENGE`, `AGENT_SIGNUP`, `AGENT_SIGNUP_DAILY`) be the real ceiling. It says nothing about *who* or *what* is signing up, and nothing here depends on it doing so.
3. **A leaked claim link lets a stranger start a claim but not finish one.** Finishing requires the user code (short-lived, hashed at rest, single-use), inside the 15-minute expiry, from a browser session signed in as a `human` account. The worst outcome of a leaked claim link is that a stranger *claims the agent and becomes its payer* — which costs the stranger money, not the agent or the original holder. A leaked link cannot read the agent's data, cannot obtain its secret, and cannot mint its tokens.
4. **No free credits means no free spend — but not no cost.** An unfunded agent can still create rows and upload within the free-tier storage quota. Rate limits and the 30-day lifecycle for never-authenticated signups ([D-30]) bound this; they do not eliminate it.
5. **The reserved domain is a convention enforced in code, not a network property.** `agents.pagespace.invalid` cannot resolve (RFC 2606), but its safety inside PageSpace depends on the five inbound denylist sites and the one outbound suppression point staying in place. Those are mutation-checked and enumerated by a test (ADR 0007 §4).

## 5. Threats and controls

| # | Threat | Control | Where it lives |
|---|---|---|---|
| T1 | Bulk account creation (row/storage exhaustion, spam identities). | PoW challenge (single-use, 5-minute TTL, server-issued, consumed atomically); `AGENT_SIGNUP` 5/60min/IP; `AGENT_SIGNUP_DAILY` 10/24h/IP; free-tier storage quota; 30-day lifecycle for never-authenticated signups. | `pow.ts`, `decideAgentSignup`, rate limits, `decideAgentLifecycle`. |
| T2 | Challenge replay / precomputation. | Challenge is random, hashed at rest, bound to `expiresAt`, consumed on first use (`UPDATE … WHERE consumedAt IS NULL RETURNING`); a consumed or expired challenge is `challenge_invalid`. | `decideAgentSignup`, Phase 1 service. |
| T3 | Secret guessing / credential stuffing on the sign-in door. | 32-character CSPRNG-seeded CUID2 body (≈ 165 bits); shape check before any lookup; lookup by SHA3-256 hash; `AGENT_SIGNIN` = `LOGIN` limits; lockout increments on failure; **constant-shape 401** — unknown, revoked, suspended and locked all look identical on the wire. | `isAgentSecretShape`, `decideAgentSignin` (typed internally, one reason on the wire). |
| T4 | Agent secret presented to the wrong grant / client. | jwt-bearer and the claim grant are allowed only for `client_id=pagespace-agent`; `pagespace-cli` keeps its existing grants; `drive:*`, `all_drives` and key-shaped scopes are refused on the assertion grant. | `clients.ts`, token route (Phase 2). |
| T5 | Reserved domain entering a human auth flow (an attacker registers `agent-x@agents.pagespace.invalid` by magic link and inherits an agent's identity via the email unique index). | The five-site inbound denylist with the ordinary "invalid email" issue (no oracle); the `users.email` unique constraint means the synthetic address is minted only by the agent-account service. | `notAgentReservedEmail`, Phase 1 sites. |
| T6 | Mail sent to the reserved domain (bounces, provider reputation, information leak in bounce bodies). | Outbound choke point no-ops for the domain. | `email-service.ts` (Phase 1). |
| T7 | A non-human "claims" an agent (an agent claiming an agent to chain billing, or an agent claiming itself). | `decideClaimApproval` denies any claimer whose `accountType !== 'human'` before every other check; mutation-checked. | `claim-decision.ts`. |
| T8 | Double claim / claim race. | `already_claimed` when `ownerUserId` is set; approval sets owner, `claimedAt` and nulls `claimTokenHash` in one transaction; a settled claim record stays settled. | `decideClaimApproval`, Phase 4 service. |
| T9 | Claim-poll hammering. | RFC 8628 vocabulary: `slow_down` when polled faster than `pollIntervalSeconds`; `OAUTH_DEVICE_POLL` limits reused. | `decideClaimPoll`. |
| T10 | Agent spends without funding (the $5 starter grant). | `starterGrantCents` is 0 for agents at **both** lazy branches; no `free-init-<agentId>` ledger row can exist; `requires_funding` → 402 with `claim_url`. Mutation-checked. | `credit-pricing.ts`, `credit-gate.ts` (Phase 1). |
| T11 | Owner charged after unlinking, or agent keeps spending after revoke. | `resolveBillingPayer` is evaluated at each of the three seams per call, never cached; revoke bumps `tokenVersion` so live tokens die. | `agent-payer.ts`, Phase 4. |
| T12 | Agent obtains a Stripe customer / subscription with an undeliverable address. | `api/stripe/customer` refuses `accountType === 'agent'`. | Phase 1. |
| T13 | Deployment where the door should not exist (onprem without opt-in). | `isAgentSignupEnabled` is the single predicate; disabled ⇒ routes and page 404; `decideAgentSignup` reports `disabled` before revealing any challenge state. | `enabled.ts`, `signup-decision.ts`. |
| T14 | Issuer / URL injection into discovery documents. | `buildServerMetadata` and `buildAuthMd` derive every URL from the configured issuer only, never a request `Host`. | `metadata.ts`, `auth-md.ts`. |

## 6. Unclaimed agents reaching humans — pending D-31

**pending D-31.** The decision whether an unclaimed agent may initiate DMs, invitations and uploads is open on the global Decisions list (D-31). It is implemented through exactly one mechanism — when `emailVerified` is stamped on the agent's `users` row (at signup, or at claim) — because the seven `isEmailVerified` gates and four `isNotNull(emailVerified)` filters already enforce it. No gate is edited either way. When the orchestrator posts the answer in the epic channel, this section is replaced by its one-sentence consequence for unclaimed agents, and Phase 1 stamps accordingly.

## 7. Residual risk accepted

- Secret theft from the agent's own environment (§4.1).
- CPU-rich attackers paying the PoW cost and staying under the per-IP limits across many IPs (§4.2); the cost to us is rows, not money.
- A stranger becoming an agent's payer via a leaked claim link (§4.3); the stranger can unlink at any time and is the only party out of pocket.
