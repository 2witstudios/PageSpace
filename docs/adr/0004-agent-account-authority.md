# ADR 0004 — Agent Account Authority: grant, canonical request digest, permissions, delegation, approval

- **Status:** Proposed (L1·G1a contract — freezes the shapes G1b implements and every later gate consumes)
- **Date:** 2026-09-15
- **Deciders:** Agent Accounts & Credential Broker epic (`j471yhv7p3abea7mlxrchdu1`), Control Board `pzutwyfnczxwkd61jhk3nya0` §1
- **Related:** the threat model (`docs/security/agent-accounts-threat-model.md`, principals §3, intersection §4); ADR 0005 (the plane that consumes a verified grant); ADR 0006 (who may present one). House style: ADR 0003.
- **Frozen files:** `packages/lib/src/agent-accounts/grant.ts`, `packages/lib/src/agent-accounts/canonical-request.ts`, `packages/lib/src/agent-accounts/audit.ts` (shape), `packages/lib/src/permissions/account-permissions.ts`.

## Question

What is the unit of authorization for a credentialed operation, who may hold it, what exactly does it bind, and which PageSpace permission decides whether a person or an agent may cause one to be issued?

## Decision (summary)

1. **A signed, one-use, ≤ 15-minute action grant** is the only thing the credential plane accepts. It binds every principal in threat-model §3 plus the operation and a **canonical request digest**; every field is required. It is Ed25519-signed under an **issuer key separate from the env-bridge's**, with its own audience. Verification is a pure function with a fixed deny order; replay state is a Postgres table shared across replicas.
2. **The digest covers the frozen request** — method, normalized destination, the reserved-header set, exact body bytes, and operation-specific resources — and is computed from a canonical projection defined once, on both the issuer and the executor side (the `grant-args.ts` discipline).
3. **Four distinct account permissions — `view` / `use` / `manage` / `grant` — plus the default-off `session_http` exception** live in `packages/lib/src/permissions/account-permissions.ts` as a pure decision over facts the repository fetched. `canUserViewPage` and every page permission grant **nothing** on an account.
4. **Unattended runs need a recorded delegation with an expiry**; user-owned accounts never silently attach to a shared agent; copies, moves, ownership transfers and membership changes invalidate bindings by bumping `policyVersion`.
5. **Approval outcomes are `allow_once | always | deny`**, bound to the digest (once) or to a bounded policy (always: scope, trigger, duration, limits, approver). An approval is an authenticated human decision received by the authority directly; model text never carries authority.

Everything below is the verified evidence and the exact, testable contract.

---

## 1. Verified ground truth

- **The env-bridge grant is the reference shape and it earns it** (B0 §"Verified controls"): strict zod schema, Ed25519 only with no `alg` field (`auth/env-bridge-signing-key.ts:17`), TTL ≤ 60 s, fixed deny order, nonce consumed only on `ok` (`env-bridge/grant.ts:226-264`), `argsHash` projection defined once for signer and gate (`env-bridge/grant-args.ts:130-165`), `constantTimeEqual` throughout. Two things do **not** carry over: its `NonceStore` is single-process by design (`grant.ts:84-93`, confirmed by B0), and its principal is `{userId, sessionId, conversationId}` — three of the eleven principals a credentialed operation needs.
- **The caller-limit model already exists and is the ceiling we must consume, never fork**: `ServiceAuthResult.allowedDriveIds` (`apps/web/src/lib/auth/index.ts:74-92`, `[]` = no ceiling), carried across dispatch hops by `AgentDispatchPayload.allowedDriveIds` + `originatingMcpTokenId` (`packages/lib/src/auth/agent-dispatch-payload.ts`), evaluated by the single-sourced `isDriveWithinCredentialScope` (`packages/lib/src/agent-workspaces/credential-scope.ts`). Axiom 8 (`docs/2.0-architecture/agent-sessions.md`): the ceiling binds every verb and is asked first; B0 found two exceptions (`command-tools.ts:63,79,131`, `skill-tools.ts:77-83`) precisely where a user-only helper was used instead.
- **Page RBAC is the wrong shape for account use, verified in a neighbour**: `integration_tool_grants` resolve by `agentId` alone and the executing user is audit-only (`ai/core/integration-tool-resolver.ts:77,81`); any drive member may grant a drive connection and a `visibility:'private'` personal connection is exercised by anyone who can drive the agent (`api/agents/[agentId]/integrations/route.ts:202-210`). The permission layer has page verbs only (`permissions.ts:284-312`: `canUserViewPage/Edit/Share/Delete`), an agent-side mirror (`agent-permissions.ts`), and no account concept.
- **Action binding precedent**: `computeActionBindingHash` (`auth/step-up-decisions.ts`) JSON-encodes sorted `[key, value]` pairs — never a delimiter join — because several values are client-supplied strings; `computeMcpTokenActionBinding` (`auth/mcp-token-scopes.ts`) adds an `op` discriminator so a grant for one operation cannot be redeemed for another. Both rules are inherited here.
- **There is no tool-approval mechanism today** (B0 Info: zero `needsApproval` under `apps/web/src/lib/ai`; `ask_user` is information-gathering). PR #2629 ("tool approvals — the assistant asks before it acts") is in flight and is the candidate *presentation* surface; this ADR fixes what an approval must bind so that surface can be reused without becoming the authority (Codex: reuse `ask_user` presentation only if the authority receives the human decision directly).
- **The local-daemon approval cache is the anti-pattern** (B0 Medium, `packages/cli/src/env-bridge/ask.ts:34-35,59-60`): one "Allow?" keyed on `(userId, sessionId, op)` makes every later request's `argsHash` binding vacuous. Account approvals therefore key on the digest.
- **Replay across replicas**: Codex: "a replicated broker needs atomic shared consumption that survives restart, plus expiry and revocation checks". The repo already has the pattern: `dev_preview_grants` is consumed by one conditional `UPDATE … WHERE consumedAt IS NULL AND expiresAt > now` across every web replica with no cache (`packages/db/src/schema/dev-preview-grants.ts` header comment).

## 2. Decision D1 — the action grant

### 2.1 Shape (frozen; `packages/lib/src/agent-accounts/grant.ts`)

Every field is **required**. Absence is encoded as `null` only where the field's documentation says a null is a legal state (there are five: `delegationId` when a live human session is the authority; `originatingMcpTokenId` when the chain did not start at a scoped key; `human.sessionId` when no live session exists (an unattended run, which then requires a delegation — F7); `agentPageId` when no agent page is in the chain; `sandbox` when `aud` is not `'relay-runner'`). `undefined` and missing keys are malformed.

| Field | Type | Binds | Verified against |
|---|---|---|---|
| `grantId` | `GrantId` | this grant, for audit | — |
| `iss` | `'pagespace-account-authority'` | the issuer | the pinned issuer key |
| `aud` | `PresenterChannel` (`'http-executor' \| 'relay-runner' \| 'browser-worker' \| 'refresh-worker'`) | which executor class may present it | the presenter's own channel |
| `tenantId` | `TenantId` | the security domain (ADR 0005 §3) | the account row's tenant and the store identity |
| `human` | `{ userId: UserId; sessionId: SessionId \| null }` | the acting human (session present when live) | the dispatch's `actingUserId` |
| `delegationId` | `DelegationId \| null` | the recorded delegation for an unattended run; `null` only when `human.sessionId` is non-null | `agent_account_delegations` (unexpired, unrevoked) |
| `agentPageId` | `AgentPageId \| null` | the agent page; `null` for the global assistant | the account's binding |
| `conversationId` | `ConversationId` | the thread | — |
| `runId` | `RunId` | the one dispatched turn / workflow run | the presenter's current run |
| `sandbox` | `{ instanceId: SandboxInstanceId; generation: SandboxGeneration } \| null` | the sandbox a relay op executes against; `null` for HTTP/browser | `getSprite().id` + the provisioner's generation (ADR 0006) |
| `callerCeiling` | `{ allowedDriveIds: AgentDispatchPayload['allowedDriveIds']; originatingMcpTokenId: string \| null }` | the inherited credential ceiling | `isDriveWithinCredentialScope(allowedDriveIds, account.driveId)` |
| `accountId` | `AccountId` | the account | the row |
| `credentialVersion` | `CredentialVersion` | the store version the executor may resolve | `resolve` refuses any other version |
| `policyVersion` | `PolicyVersion` | the account policy this grant was evaluated under | the row's current `policyVersion` |
| `bindingDigest` | `BindingDigest` | `hash(canonicalJson(PlaneBindings))` — the authority's signed copy of `(tenantId, ownerRef, allowedOrigins, policyVersion, kind)` it evaluated | the store's own `PlaneBindings` digest at resolve (ADR 0005 §2.4); a tampered main-DB row cannot produce a matching grant |
| `sessionHttp` | `boolean` | whether the default-off `session_http` permission was granted for this use (§4.1); the only way a `session` kind reaches the HTTP executor | the account's `sessionHttpEnabled` flag and `decideAccountAccess` |
| `operation` | `OperationRef` (`{ class: OperationClass; name: string }`) | the typed operation (§3.4) | the request's operation |
| `requestDigest` | `RequestDigest` | `hash(canonicalizeRequest(request))` | recomputed by the presenter from the frozen request |
| `approvalId` | `ApprovalId \| 'policy'` | the approval decision consumed (§4.3); the `'policy'` sentinel id when a bounded always-allow applied | the approvals table |
| `iat`, `nbf`, `exp` | `number` (ms) | validity window; `exp - iat ≤ 15 min`; `nbf ≤ iat` | the injected clock |
| `nonce` | `Nonce` | one-use | the replay store |
| `presenter` | `{ keyId: PresenterKeyId; channel: PresenterChannel }` | the executor key that must sign the *use* | the executor's own key; `channel === aud` |

Principal types are **branded** (`Brand<string, 'UserId'>` etc.): a `RunId` is not assignable to a `SandboxInstanceId`. `type`, never `interface`; readonly everywhere.

**What the verifier compares against.** `ExpectedBinding` carries the presenter's *current* execution principals — `human`, `agentPageId`, `conversationId`, `runId` — taken from the presenter's own run context, never from the grant. A valid, unused grant issued for another agent page, thread or run that reaches the same presenter is refused as `principal_mismatch` (F4a). This is what makes the cross-agent and cross-run substitution rows in the threat model (A3) decidable by a pure function rather than by convention (Codex P1 on PR #2637).

### 2.2 Signing

- Ed25519 only, no `alg` field, over `encodeGrant(grant)` — a canonical JSON with a fixed key order rebuilt from the typed grant, never from the caller's object (env-bridge precedent).
- **Separate signing authority**: a new key `ACCOUNT_AUTHORITY_SIGNING_KEY`, generated and pinned the way `auth/env-bridge-signing-key.ts` does it, with `iss`/`aud` distinct from the env-bridge's so a bridge grant can never verify as an account grant and vice versa (Codex: "separate audience and signing authority for account operations").
- The web process holds **no unrestricted signing authority**: issuance happens in the authority service after the intersection (threat-model §4) is satisfied, and the key is not readable by route handlers (ADR 0005 §7 says where it lives).

### 2.3 Lifetime

`exp - iat ≤ GRANT_MAX_TTL_MS = 900_000` (15 min, aidd-jwt-security ceiling). Clock skew tolerance `GRANT_MAX_CLOCK_SKEW_MS = 30_000`, as the env-bridge. Grants for `browser-worker` sessions are re-issued per action, never long-lived per session.

### 2.4 Replay store

`agent_account_grant_nonces` (G1b creates it; ADR 0005 §2.5 names the table): `(nonce PK, grantId, exp, consumedAt)`. Consumption is one conditional insert-or-update that succeeds exactly once across every replica and survives restart; expired rows are swept opportunistically. The pure verifier takes the *result* of that I/O (`nonceState: 'fresh' | 'consumed' | 'unknown'`) — it never performs it — and the adapter records the nonce **only** when the whole verdict is `ok` (§6 F12).

## 3. Decision D2 — canonical request and digest

### 3.1 Why a digest and not the request

The approval UI shows one representation; the executor must run exactly that one. Freezing the request as bytes and hashing them on both sides is the only way "approve one, execute another" becomes a `digest_mismatch` rather than a review finding.

### 3.2 Canonical projection (frozen; `canonical-request.ts`)

`canonicalizeRequest(input: CanonicalRequestInput): CanonicalizeResult` (`{ ok: true; canonical } | { ok: false; reason: CanonicalizeRefusal }`) is pure and total. Fixed field set, fixed order; absent optionals are `null`/`[]`/`{}` never missing (env-bridge `grant-args.ts` rule).

| Field | Rule |
|---|---|
| `method` | uppercase; from a closed set per channel (`GET/HEAD/POST/PUT/PATCH/DELETE` for HTTP; `git-receive-pack/git-upload-pack/lfs-batch/lfs-upload` for the relay; `navigate/click/type/read/wait/fill` for the browser) |
| `origin` | `https://` only; host IDNA→ASCII lowercase; explicit port always present (`:443` is written); **userinfo → refuse**; **wildcards → refuse**; IP literals → refuse (private ranges are never an origin; public IP literals need a hostname) |
| `path` | dot-segments resolved; each segment percent-decoded **once**, refused if a `.`/`..` part or any control character survives that decode, then re-encoded canonically (upper-case hex). An encoded `/` (`%2F`) stays encoded, so it can never become a segment boundary |
| `query` | split on the first `=` per pair; each half **normalized, never decoded**: upper-case the hex of every escape, unescape only the RFC 3986 unreserved set, percent-encode anything the component may not carry verbatim, refuse a control character in either form, never read `+` as a space. Sorted by name, duplicates kept in input order |
| `headers` | **only** the reserved-and-allowed set is projected, lowercase, sorted: `accept`, `content-type`, `content-length`, and the operation's declared headers. `authorization`, `cookie`, `host`, `proxy-*`, `x-forwarded-*`, `transfer-encoding`, `connection`, `upgrade` are **refused** if the caller supplies them (the executor sets them). A projected header whose **value** carries a control character is refused too (`malformed`) — a name-only check lets CRLF smuggle `authorization:` inside an admitted `accept`. `content-length` is **derived** from the body bytes, always: a caller-supplied value that disagrees is `malformed`, and a correct one projects identically to its absence |
| `bodySha256` | hex SHA-256 over the exact body bytes; `''` body → hash of zero bytes, never `null` |
| `resources` | operation-specific identifiers the policy restricts on (repo, org, recipient, webhook target, frame origin for browser ops), as a sorted `[key, value]` list |
| `operation` | `{ class, name }` — the `op` discriminator so one digest cannot serve two operations (mcp-token-scopes precedent) |

`digestRequest(canonical): RequestDigest = hash(canonicalJson(canonical))` where `canonicalJson` sorts keys recursively, keeps arrays positional, drops `undefined` (env-bridge `canonicalizeArgs`), and the hash primitive is injected. Two textual requests that differ only by header order, key order, case of the host, or `:443` produce the same digest; two that differ in one body byte do not.

**Amendment 2026-09-16 (G1b review, under §3.3's invariant).** The first wording said the query was "canonically encoded" and projected `content-length` only when present; read as "decode, then hash", it let `?to=a+b` and `?to=a%2Bb` (a form-decoding server reads the first as `a b`), `?q=/safe` and `?q=%2Fsafe`, and `?x=a&b` and `?x=a%26b` share one digest, so approve-one/execute-another produced no `digest_mismatch`. An empty body with an explicit `content-length: 0` also digested differently from the identical request without it, and header values went through unchecked. The rows above now state the rule the G1b implementation (#2638) follows; no type changed. Assertion §8.26 pins it, and its round-trip input must be built verbatim — a helper that re-encodes performs exactly the normalization under test.

### 3.3 Where the request is frozen

The authority freezes the canonical request **before** it asks for approval and stores it beside the approval (`agent_account_approvals.requestDigest`). The executor recomputes the digest from the request it is actually about to send and refuses on mismatch. Approval UI text is rendered *from* the canonical request (never from model text — threat-model B-9/B-22, ASI06).

### 3.4 Operation classes

"Ask on write" is decided by typed semantics, never by HTTP method (Codex; B0 Info). `OperationClass = 'read' | 'write' | 'irreversible' | 'privilege' | 'unknown'`:

| Class | Examples | Approval rule |
|---|---|---|
| `read` | list issues, fetch a page | policy may `always` allow |
| `write` | create issue, comment, upsert a row | policy may `always` allow **within** declared resource bounds |
| `irreversible` | merge PR, delete file, send mail, force push | concrete approval per digest; `always` is refused for this class |
| `privilege` | create token/key, change recovery email/2FA, add webhook, bulk export, change org membership | concrete approval per digest **plus** step-up (`step-up-decisions.ts`), never `always` |
| `unknown` | any generic `http_request` whose operation schema is not reviewed | concrete approval per digest unless the human explicitly accepted "generic requests to this origin" as a bounded capability with limits |

Provider tool catalogues (`integrations/providers/*.ts`) are reclassified to this union in G3 (B0 B-6).

## 4. Decision D3 — account permission semantics (`packages/lib/src/permissions/account-permissions.ts`)

### 4.1 The four permissions

| Permission | Means | Who has it (v1, D-16 ownership: user-owned or agent-page-owned) |
|---|---|---|
| `view` | see that the account exists: kind, name, allowed origins, status, last use. **Never the secret, never a resolvable handle** | the owner; for agent-page-owned: drive OWNER/ADMIN and members who can `edit` the agent page (they can already see its config) |
| `use` | cause an operation to be issued under this account | user-owned: the owning user only, and only when they are the acting human of the run (never when *another* user invokes a shared agent that user configured — Codex); agent-page-owned: the acting human must have `use` **and** the agent page must be bound to the account **and** the caller ceiling must admit the drive |
| `manage` | change allowed origins, operations, approval policy, limits, kind-specific settings; rotate; revoke; delete; **edit the agent's instructions when the agent is bound to an account** (Λ15) | user-owned: the owner; agent-page-owned: drive OWNER/ADMIN of the *human* actor (an agent's own drive membership never confers `manage`, B0 B-24) |
| `grant` | bind the account to an agent page, create/extend a delegation, widen a policy | user-owned: the owner; agent-page-owned: drive OWNER/ADMIN; **always** through step-up for widening |
| `session_http` | let the HTTP executor resolve a `session` kind (a cookie jar over plain HTTP, outside the browser worker). **Default off.** | true only when `use` is true **and** the account's `sessionHttpEnabled` flag is on; the flag is set through `manage` (step-up, since it widens where a post-MFA session may be replayed). The grant carries `sessionHttp: true` and the adapter exposes it only through `resolveSessionOverHttp` (ADR 0005 §4.2) |

`view` does not imply `use`; `use` does not imply `manage`; `manage` does not imply `grant`; `session_http` requires `use` and the flag. Each is decided independently by `decideAccountAccess` (§7) over the `AccountAccessFacts` the repository fetched — no tool-only policy, no route-local check.

### 4.2 What never grants anything

- `canUserViewPage`, `canUserEditPage`, drive membership, `hasAgentDriveMembership`, being in the conversation, being the workspace owner: none is an account permission. A test asserts that a caller holding every page permission and no account row still gets `{ view:false, use:false, manage:false, grant:false, session_http:false }`.
- A model-reported approval, a page body, a compaction summary, a command page: text has no authority.

### 4.3 Approval outcomes and policy

`ApprovalOutcome = 'allow_once' | 'always' | 'deny'` (Muse vocabulary, adopted by the epic). Outcomes are not a policy; **`AccountApprovalPolicy`** is:

```text
{ scope: { origins, operations (by class + name), resources },
  trigger: 'every_use' | 'unknown_and_irreversible' | 'irreversible_only',
  duration: { until: ms } | null,
  limits: { maxUsesPerHour, maxBytesOut, maxConcurrent },
  approver: UserId }
```

`always` writes a bounded policy row; a later grant under it carries `approvalId = 'policy'` and the policy's version is folded into `policyVersion`. `allow_once` writes an approval row bound to the digest and consumed exactly once — **by the grant issuance that used it**: the row records `consumedByGrantId`, and the verifier accepts a concrete approval only when that id equals the signed `grantId` (`null` = never issued against; another id = a competing issuance won). A bare "consumed" flag cannot tell first legitimate use from reuse (Codex P1 on PR #2637). `deny` writes an audit row and issues nothing. Approvals are received from the authenticated human session (or step-up for `privilege`) through the approval route; the `ask_user`-style presentation is a renderer only.

### 4.4 Delegation and binding invalidation

- **Unattended run** (cron, workflow, a worker dispatched with no live session): the authority requires a `agent_account_delegations` row `(delegationId, accountId, agentPageId, delegatedBy, expiresAt, revokedAt, scope)` that is unexpired and unrevoked; the grant carries `delegationId` and `human.sessionId = null`. No delegation → `no_delegation`.
- **Invalidation** is one mechanism: `policyVersion` bumps whenever the account's owner, tenant, origins, operations, approval policy, or bound agent page changes; when the agent page is copied, moved across drives, or has its ownership transferred; when the bound agent's instructions or tool surface change (Λ15); and when drive membership of the owner changes. A grant issued under the previous `policyVersion` is `policy_epoch` at the plane. Bindings are therefore invalidated, not re-evaluated by whoever views the conversation later.

## 5. Decision D4 — audit record shape (frozen; `packages/lib/src/agent-accounts/audit.ts`)

`AgentAccountAuditRecord` carries: `principal` (every §3 principal by id), `accountId`, `credentialVersion`, `policyVersion`, `approvalId`, `grantId`, `operation`, `normalizedAction`, `outcome` (`'allowed' | 'denied' | 'executed' | 'upstream_failed' | 'unknown'` with `denyReason` when denied), `presenter`, `at`. It carries **no** raw credential, no body, no response body, and no header values other than the projected names. Audit **acceptance precedes execution** (§6 F-13): the executor writes the `allowed` record durably, then acts, then writes the outcome row keyed by the same `grantId`.

**Amendment 2026-09-15 (G1b review).** The first shape projected the canonical request's `path` and `resources` verbatim, which contradicts this section's own invariant: real APIs put credentials in URLs (`/v1/tokens/<token>`, `/reset/<one-time-code>`, a presigned `X-Amz-Signature` moved into a path), and this chain is tamper-evident, so a value written here cannot be erased afterwards — Art 17 included, which is exactly why `gdpr-export-coverage.ts` treats the chain as non-erasable. `normalizedAction` therefore carries:

| Field | Rule |
|---|---|
| `origin` | the pinned canonical origin (not secret; the first thing an investigator needs) |
| `pathDigest` | `hash(canonical.path)` as SHA3-256 hex — the repo's hash for secret-adjacent values (`auth/secure-compare.ts`). Two rows for the same endpoint still match and still correlate; no path SEGMENT survives |
| `resourceIds` | the canonical `resources` filtered to the keys the TYPED OPERATION declares (repo, org, recipient, webhook target). A caller that passes any other key contributes nothing to the row |
| `channel`, `method`, `headerNames`, `bodySha256`, `operation` | unchanged |

`buildAuditRecord` accordingly takes an injected `hash` and the operation's `declaredResourceKeys`; the projection is the catalogue's, never the caller's. The query string was already absent and stays absent.

## 6. Fail-closed posture (every line is a RED test)

| # | Situation | Behaviour |
|---|---|---|
| F1 | Grant fails schema (missing/extra/`undefined` field, wrong brand shape), or `exp < iat`, or `nbf > iat` | `malformed`; nothing else evaluated |
| F2 | `iss` or `aud` not the expected constants; `presenter.channel ≠ aud` | `wrong_audience` |
| F3 | Caller ceiling does not admit the account's drive (`isDriveWithinCredentialScope` false); `manage_keys`-only credential | `ceiling` — asked before anything else that needs a DB fact |
| F4 | `tenantId` ≠ the account row's tenant | `tenant_mismatch` |
| F4a | `human.userId`, `agentPageId`, `conversationId` or `runId` ≠ the presenter's current execution principals | `principal_mismatch` |
| F5 | `accountId` unknown, revoked, or `credentialVersion` ≠ current | `version_mismatch` (unknown and revoked collapse into it toward the presenter) |
| F6 | `policyVersion` ≠ current | `policy_epoch` |
| F7 | `delegationId` null while `human.sessionId` null; delegation expired/revoked/foreign account | `no_delegation` |
| F8 | `operation` ≠ the presented request's operation; `requestDigest` ≠ recomputed digest | `digest_mismatch` (constant-time compare) |
| F9 | `sandbox` present and `(instanceId, generation)` ≠ the presenter's current binding | `generation_mismatch` |
| F10 | `exp - iat > 15 min`; `iat > now + skew`; `now < nbf`; `now > exp` | `ttl_too_long` / `clock_skew` / `not_yet_valid` / `expired` |
| F11 | Signature invalid, undecodable, or under any key but the pinned issuer key | `bad_signature` |
| F12 | Nonce already consumed, or the replay store is unreachable | `replayed` / `replay_store_unavailable` — never "assume fresh" |
| F13 | Audit record cannot be durably accepted before execution | `audit_unavailable`; the executor does not act |
| F14 | `approvalId` names an approval whose `consumedByGrantId` ≠ this `grantId` (null or another grant), bound to a different digest, or `'policy'` while the policy is expired/exceeded | `approval_mismatch` |
| F15 | Operation class `irreversible`/`privilege` with `approvalId = 'policy'` | `approval_mismatch` (always-allow never covers these classes) |
| F16 | Any deny toward an untrusted caller (the model, the sandbox) | one constant-shape refusal; the reason goes to audit only |
| F17 | `password` kind requested by `aud ≠ 'browser-worker'`; `session` kind requested by `aud = 'http-executor'` without `sessionHttp: true` | `kind_not_resolvable` (also unrepresentable by type, ADR 0005 §4) |
| F18 | Request canonicalization refuses (userinfo, wildcard, reserved header, `..` after decode, IP literal) | no grant is issued; the refusal names the rule, to the human only |

## 7. Pure-function signatures (G1b implements behind thin adapters)

All in `packages/lib/src/agent-accounts/`, one export per file, options objects, no I/O, clock and hash injected, never throwing for expected outcomes. `type` only.

```ts
// grant.ts — the shape and the verifier's contract
export type ParseGrant = (input: { readonly grant: unknown }) => ParseGrantVerdict;
//   { ok: true; grant: AgentAccountGrant } | { ok: false; reason: 'malformed' }

export type VerifyGrant = (input: VerifyGrantInput) => GrantVerdict;
//   VerifyGrantInput: { grant: unknown; signature: string; issuerPublicKey: Uint8Array;
//     now: number; expected: ExpectedBinding;   // aud, presenter, CURRENT human/agentPageId/conversationId/runId,
//                                                // tenant, account row facts, current credential/policy versions,
//                                                // delegation fact, sandbox binding, callerCeiling fact (drive admitted?)
//     requestDigest: RequestDigest;   // digestRequest over the request the presenter is about to send,
//                                     // recomputed by the presenter's adapter — never taken from the grant
//     requestOperation: OperationRef; nonceState: 'fresh' | 'consumed' | 'unknown';
//     approval: ApprovalFact; verify: Ed25519Verify; hash: HashBytes }
//   GrantVerdict: { ok: true; grant } | { ok: false; reason: GrantDenyReason }
//   GrantDenyReason is the one canonical union of every reason §6 names (F1–F17, incl. F4a and
//   F13 `audit_unavailable`, which the executor rather than the verifier returns); Record<GrantDenyReason, …> is used
//   for the audit/UI mapping so an added reason fails typecheck everywhere it matters.

// canonical-request.ts
export type CanonicalizeRequest = (input: CanonicalRequestInput) => CanonicalizeResult;
//   { ok: true; canonical: CanonicalRequest } | { ok: false; reason: CanonicalizeRefusal }
export type DigestRequest = (input: { canonical: CanonicalRequest; hash: HashBytes }) => RequestDigest;
export type RenderApprovalSubject = (input: { canonical: CanonicalRequest }) => ApprovalSubject;
//   the human-readable rendering the approval UI shows — derived from the canonical request only

// classify-operation.ts (G1b)
export type ClassifyOperation = (input: { channel: PresenterChannel; canonical: CanonicalRequest;
  catalogue: OperationCatalogue }) => OperationRef;   // unknown ⇒ class 'unknown'

// decide-approval.ts (G1b)
export type DecideApproval = (input: { operation: OperationRef; policy: AccountApprovalPolicy | null;
  requestDigest: RequestDigest; origin: CanonicalOrigin; resources: readonly (readonly [string, string])[];
  now: number; usage: UsageCounters }) => ApprovalRequirement;   // resources compared against policy.scope.resources
//   { kind: 'policy' } | { kind: 'concrete'; stepUp: boolean } | { kind: 'refuse'; reason }

// packages/lib/src/permissions/account-permissions.ts
export type DecideAccountAccess = (input: { facts: AccountAccessFacts }) => AccountAccessLevel;
//   AccountAccessLevel = Readonly<Record<AccountPermission, boolean>>
//   AccountAccessFacts: the repository-fetched facts (owner kind, actor id, acting-human id,
//     drive role of the HUMAN actor, agent binding, delegation fact, caller ceiling admits drive,
//     account status) — never a DB handle.

// audit.ts
export type BuildAuditRecord = (input: { grant: AgentAccountGrant; canonical: CanonicalRequest;
  outcome: AuditOutcome; at: number; hash: HashBytes; declaredResourceKeys: readonly string[] })
  => AgentAccountAuditRecord;   // never includes body, secret, header value, URL path or undeclared resource
```

Adapters (I/O, G1b): `grant-repository.ts` (nonce consume, approvals, delegations), `authority-executor.ts` (issue after intersection), each integration-tested against the `:5433` Postgres.

## 8. Testable assertions (each becomes a RED test in G1b)

1. Given a grant with any field absent, `undefined`, or an extra key, `verifyGrant` returns `malformed` before any other check runs (no signature call observed).
2. Given the same grant object with `exp < iat`, returns `malformed`, not `ttl_too_long`.
3. Given a `RunId` value passed where `SandboxInstanceId` is expected, typecheck fails (brand separation; `// @ts-expect-error` test).
4. Given a grant signed with the env-bridge key, returns `bad_signature`; given `aud` of another channel, returns `wrong_audience` before signature.
5. Given `callerCeiling.allowedDriveIds = ['d1']` and an account in drive `d2`, returns `ceiling` before any account fact is consulted; given `[]`, the ceiling admits every drive.
6. Given `credentialVersion` one behind current, returns `version_mismatch`; given `policyVersion` one behind, `policy_epoch`.
7. Given `human.sessionId = null` and `delegationId = null`, returns `no_delegation`; given an expired delegation fact, the same.
8. Given a request whose body differs by one byte from the digested one, returns `digest_mismatch`; given headers reordered, host uppercased, or `:443` omitted, verifies `ok` (digest identical).
9. Given `sandbox.generation` one behind the presenter's, returns `generation_mismatch` (the restored-sandbox case).
10. Given `exp - iat = 15 min + 1 ms`, `ttl_too_long`; given `now < nbf`, `not_yet_valid`; the deny order is exactly F1→F17 and a table test over all pairwise "two faults" inputs returns the earlier reason.
11. Given `nonceState = 'consumed'`, `replayed`; given `'unknown'`, `replay_store_unavailable`; the nonce is recorded only on `ok` (a grant failing F11 leaves the store untouched — the adapter test).
12. Given a `privilege` or `irreversible` operation and `approvalId = 'policy'`, `approval_mismatch`.
13. Given `canonicalizeRequest` with userinfo, a wildcard host, an IP literal, an `authorization`/`cookie`/`host` header, or `..` surviving decode, returns a refusal naming the rule; a valid input round-trips (`canonicalize ∘ canonicalize` is the identity).
14. Given `decideAccountAccess` with every page permission true and no account relationship, returns every `AccountPermission` (including `session_http`) `false`.
15. Given a user-owned account and an acting human who is not the owner (a shared agent invoked by another member), `use` is `false` even when the agent page is bound.
16. Given an agent-page-owned account and a human actor with drive role MEMBER, `manage` and `grant` are `false`; with ADMIN, `true`; an agent's own membership never yields `manage`.
17. Given `decideApproval` for class `write` under an `always` policy whose `limits.maxUsesPerHour` is exhausted, returns `refuse`; under a policy whose `duration.until` has passed, `concrete`.
18. Given `buildAuditRecord` with a body and a resolved credential in scope, the record contains neither (property test over random bodies: `JSON.stringify(record)` never includes the body bytes or the secret).
19. Mutation pairs (Control Board §7.4): break the digest compare, the nonce-only-on-ok rule, the ceiling-first rule, and the `aud` check by line index → the corresponding assertion goes red; restore → green.
20. Given a valid unused grant whose `agentPageId`, `conversationId`, `runId` or `human.userId` differs from `expected` (the presenter's current run), returns `principal_mismatch` before any version or delegation fact is consulted (PR #2637 P1).
21. Given a concrete approval fact with `consumedByGrantId = null`, returns `approval_mismatch`; with another grant's id, `approval_mismatch`; with this `grantId`, verifies `ok` (PR #2637 P1).
22. Given `decideApproval` under an `always` policy whose `scope.resources` names repo A and a request whose `resources` name repo B, returns `refuse(out_of_scope)`; with repo A, `policy` (PR #2637 P1).
23. Given a `session` kind and `aud: 'http-executor'` with `sessionHttp: false`, returns `kind_not_resolvable`; `decideAccountAccess` returns `session_http: true` only when `sessionHttpEnabled` and `use` are both true (PR #2637 P1).
24. Given a grant whose `bindingDigest` was computed over bindings that differ from the store's copy in owner or origins, the plane returns `binding_mismatch` (ADR 0005 §10.5); the grant type requires the field (a grant without it is `malformed`).
25. Given a canonical request whose PATH contains a token-shaped segment (`/v1/tokens/ghp_…`) and whose `resources` carry an undeclared key, `buildAuditRecord` produces a record containing **no substring** of either: the path is present only as `pathDigest`, and the undeclared resource is absent entirely. Two requests to the same path still produce the same `pathDigest`, and two different paths produce different ones (G1b review amendment; §5).
26. Given query pairs `?to=a+b`/`?to=a%2Bb`, `?q=/safe`/`?q=%2Fsafe` and `?x=a&b`/`?x=a%26b`, `digestRequest` returns different digests for each pair; given lower-case escape hex or an escaped unreserved character, the same digest as the normalized form; given a body with and without a correct `content-length`, the same digest; given an admitted header value containing CR or LF, or a `content-length` that disagrees with the body, `canonicalizeRequest` refuses `malformed`. The §8.13 round-trip input is built verbatim, never re-encoded by the test (G1b review amendment; §3.2).

## 9. Consequences

- The env-bridge grant is untouched; the account grant is a sibling with its own key, audience and eleven-principal shape. Nothing imports one into the other.
- `packages/lib/src/permissions/` gains an account concept for the first time; every account route and tool calls `decideAccountAccess` — a route-local check is a review defect.
- Approvals gain a durable table bound to digests; PR #2629's presentation can render `ApprovalSubject` but the decision reaches the authority through the approval route with the human's session.
- `policyVersion` is the single invalidation mechanism, so page copy/move/transfer handlers and the agent-config doors (`agent-tool-surface.ts` family) get one hook: bump the versions of bound accounts.
