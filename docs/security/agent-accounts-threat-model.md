# Agent Accounts & Credential Broker — threat model

- **Status:** Frozen at L1·G1a (epic `j471yhv7p3abea7mlxrchdu1`, Control Board `pzutwyfnczxwkd61jhk3nya0`). Changes to §1–§5 are a `[D-n]`, not a PR.
- **Date:** 2026-09-15
- **Owner:** G1a (this document), consumed by G1b–G7, UI copy, marketing.
- **Inputs:** the Codex security review (`km6yrydf0sc08g6ikoikno7f`), the B0 review-agents baseline (`qa5qojg6hensf8b8hz45hwxn`, 27 findings at `632ba653a`), spikes S1 (`docs/spikes/2026-09-sprites-trusted-transport-spike.md`), S2 (`docs/spikes/2026-09-credential-broker-vendor-eval.md`), S3 (`docs/spikes/2026-09-browser-worker-substrate-spike.md`), decisions D-16..D-23 (answered), D-24/D-25/D-29 (open — this document is parameterized on them, §10).
- **Companions:** ADR 0004 (authority: grant, digest, permissions, delegation), ADR 0005 (credential plane: store adapter, keys, identities, extend-vs-new), ADR 0006 (sandbox caller identity).

## 1. The contract (frozen wording)

This is the sentence the product, the docs and the marketing site may make. Nothing stronger.

> **Agent-controlled code can request narrowly authorized actions. Credential plaintext exists only in an isolated credential execution plane and at the intended provider. Agents cannot retrieve credentials through any supported interface. Compromise of that plane, its host administrator, or the intended provider is a credential-compromise event.**

Each clause has a mechanism and an owner gate:

| Clause | Mechanism | Gate |
|---|---|---|
| "can request narrowly authorized actions" | every credentialed operation is a typed operation under a bounded **action grant** (ADR 0004 §2) bound to a **canonical request digest** (ADR 0004 §3); unknown generic requests need concrete approval | G1b (verify), G2 (executor) |
| "plaintext exists only in an isolated credential execution plane" | the executors (HTTP, relay, browser fill) are the sole callers of `resolve`; Next.js holds references only, no store identity, no keys (ADR 0005 §2) | G1b, G2 |
| "and at the intended provider" | origin pinning + in-provider restriction (repo, org, recipient, webhook target); redirects are re-authorized per hop | G2 |
| "cannot retrieve credentials through any supported interface" | there is no `getSecret`/`resolve` tool; model-visible surfaces carry an `accountId`, never a value or a substitutable placeholder (epic invariant 1) | every gate; adversarial harness |
| "compromise of that plane … is a credential-compromise event" | stated, not mitigated: the plane's runtime, its host admin and the provider are inside the trusted computing base. §7 says which components those are per deployment mode | G1a |

The retired wording "the secret is never visible to the model" is **not** used anywhere. It was false (§2.1) and Codex retired it.

## 2. Explicit non-guarantees

These are stated to users (copy in §9) and never softened in product text.

### 2.1 An authorized site can echo or mint credentials (Λ10 — accepted, G1a)

Generic HTTP and browser access cannot guarantee non-disclosure against an actively malicious *authorized* destination. A pinned origin can echo the credential back in a response body, encode it, paint it on a canvas, display it in an account-settings page, or mint a *new* credential and show it. Redaction of known values is a **tripwire**, not a boundary (`packages/lib/src/services/sandbox/audit.ts:68-70` says so for the sandbox and that stance is kept). Consequences we do build: sensitive account-management surfaces (token creation, recovery, privilege expansion, bulk export) need a separate approval class (ADR 0004 §4), and the executor filters response headers/bodies before release. Consequence we do not claim: that a hostile authorized site cannot learn its own credential.

### 2.2 The onprem operator controls broker, store and host (Λ11 — accepted, D-21)

Ordinary software cannot keep reusable credentials secret from an operator who runs the broker, the store and the machine they execute on. An HSM protects key extraction; it does not stop that operator from reading decrypted sessions in memory or invoking authorized operations. Excluding the operator needs a separate trust domain or attested execution with independently controlled key release, which is out of scope (D-21: onprem is not a priority; no gate blocks on onprem). §7 states the resulting trust per mode.

### 2.3 Memory is not zeroized

Bun/JavaScript strings are garbage-collected; clearing a variable does not erase memory. The plane relies on bounded worker lifetimes, no request-body telemetry, disabled core/heap dumps and protected swap (ADR 0005 §6). We do not promise exact zeroization.

### 2.4 Replay protection is not idempotency

A one-use grant prevents a second *authorization*; it does not prevent a duplicate *upstream write* when a timeout follows a successful write. Retries of non-idempotent operations are never automatic (B0 Low, `http-executor.ts:173-181`); the executor reports `outcome: 'unknown'` and the human decides.

## 3. Principals (never interchangeable)

Every credentialed decision names all of these separately. They are **branded types** in `packages/lib/src/agent-accounts/grant.ts` so a `RunId` cannot be passed where a `SandboxInstanceId` is expected; the compiler, not review, enforces the separation.

| Principal | Branded type | Source of truth | Why it is not another principal |
|---|---|---|---|
| Initiating human | `UserId` | `users.id`; carried as the *acting* user exactly as `agent-dispatch-payload.ts` carries `actingUserId` | a human viewing a conversation later is not the human who delegated (Codex: "do not reconstruct authority from whichever user happens to view the conversation") |
| Delegation | `DelegationId` | `agent_account_delegations` row (ADR 0004 §5): who delegated, to which agent, until when | an unattended run has no live human; the delegation *is* the human's standing consent, with an expiry |
| Tenant / security domain | `TenantId` | derived, never chosen: `user:<userId>` for user-owned accounts, `drive:<driveId>` for agent-page-owned accounts (D-16; ADR 0005 §3). A drive is not automatically a tenant; a user-owned global account sits outside every drive | keys and store identities are per tenant (D-17, Λ4); a wrong tenant is a cross-tenant read |
| Agent page | `AgentPageId` | `pages.id` of the agent | "the agent" is standing configuration with its own RBAC (`agent-permissions.ts`); editing its instructions redirects standing authority (B0 Medium, `agent-tools.ts:60,78-84` → Λ15) |
| Conversation / run | `ConversationId`, `RunId` | `conversations.id`; the run is one dispatched turn (`browserSessionId` of the dispatch or the workflow run id) | authority is bound to *this* run so a captured grant cannot serve another turn |
| Sandbox instance | `SandboxInstanceId` | Sprites `sprite-<uuid>` from `createSprite`/`getSprite` (S1 §4); `agent_workspaces.spriteInstanceId` | survives checkpoint restore, changes on delete+recreate — the ABA guard (S1 verified) |
| Sandbox generation | `SandboxGeneration` | monotonic counter the provisioner increments on every recreate/restore of the same workspace (`machine_sprite_reclaims`) | a restored-from-snapshot guest replaying a grant is the attack this exists for |
| Caller ceiling | `CallerCeiling` (`allowedDriveIds`, `originatingMcpTokenId`) | the Sign-in epic's caller-limit model: `ServiceAuthResult.allowedDriveIds` / `AgentDispatchPayload.allowedDriveIds`, evaluated by `agent-workspaces/credential-scope.ts` `isDriveWithinCredentialScope` | a drive-scoped key is not its user (agent-sessions axiom 8); the ceiling is inherited across every hop and asked FIRST |
| Presenter | `PresenterKeyId` + `PresenterChannel` | the *server-side* executor that presents the grant (HTTP executor, Git/CLI relay runner, browser worker), identified by its signing key | S1: no guest→server channel exists; the guest is never a presenter (ADR 0006) |
| Account + credential version | `AccountId`, `CredentialVersion` | `agent_accounts.id` and the store's secret version | a grant for version *n* must not resolve version *n+1* after rotation |
| Policy version | `PolicyVersion` | `agent_accounts.policyVersion`, bumped on every change to origins/operations/approval policy | a grant issued under an older policy is refused after the owner tightens it |

## 4. The authorization intersection

An operation runs only inside the intersection; any empty factor refuses. Order is fixed (ceiling first, cheapest structural checks before crypto, replay last) and tested (ADR 0004 §8).

```text
caller ceiling (allowedDriveIds admits the account's tenant)
∩ authenticated workload/run (presenter key + run id + sandbox instance/generation)
∩ current human or recorded delegation (unexpired, not revoked)
∩ current PageSpace permission: `use` on the account (ADR 0004 §4 — never `canUserViewPage`)
∩ explicit account-use grant (the signed action grant, ADR 0004 §2)
∩ account restrictions (origin, in-provider resource, operation class, limits)
∩ applicable approval (allow-once bound to the digest, or a bounded always-allow)
∩ current account epoch (credential version + policy version)
∩ store identity scoped to exactly that tenant (ADR 0005 §3)
```

Main-DB integrity is a stated dependency: authorization reads mutable rows (owner, origins, policy). A main-DB writer who reassigns ownership is inside the threat model (attack row A9). Mitigation: the plane's own record independently binds `(tenantId, ownerRef, allowedOrigins, policyVersion)` in the store's metadata alongside the secret (ADR 0005 §2.4), and expansion of authority requires independently authenticated owner consent (step-up, `auth/step-up-decisions.ts`). A grant signed over tampered rows still fails at the plane when the bindings disagree.

## 5. Plaintext-residency inventory (our stack)

"Permitted" means: any other location is a defect the adversarial harness must catch. TLS termination on every path also sees plaintext; credential ingress terminates on dedicated listeners with no body capture and is excluded from request tracing/replay (ADR 0005 §6).

| Material | Permitted plaintext locations | Lifetime | Not permitted (examples the harness asserts) |
|---|---|---|---|
| User-entered API key / bearer token | the user's browser on the enrollment form; the credential-ingress route (a dedicated handler, not the general `/api` tree); the Infisical write path | the submission request; then only as ciphertext in the store | Next.js request logs, `integration_connections.credentials`, any `jsonb` in the main DB, tool results, chat messages, audit rows |
| OAuth authorization code + PKCE verifier | the plane's OAuth handler (`integrations/oauth/oauth-handler.ts` moved behind the plane in G3); the code transits the browser redirect | until exchanged or expired (10 min, `oauth-state.ts`) | the model, the sandbox, logs |
| OAuth refresh token / client secret | the store; the **one** restricted refresh worker (ADR 0005 §5) | the refresh operation; no broker-wide cache | the HTTP executor (access tokens only), Next.js, any second store (Λ5, D-24) |
| Access token / API key at use | the store; the assigned HTTP executor for one request | request duration; a cache, if any, is per `(accountId, credentialVersion)` with a documented TTL ≤ grant lifetime | sandbox env/argv/files (Λ1 today — accepted D-23, retired L4), git credential helpers, response bodies returned to the model |
| Session state (cookies, storage-state) | the store (kind `session`, declared format S3 §5); the isolated browser worker's ephemeral context; the HTTP executor only under a separate `session-http` permission | active browser session or single request; the persistent copy is store ciphertext | the agent Sprite, Sprite checkpoints (browser holder excluded from `checkpoint-policy.ts`), screenshots/a11y snapshots during login |
| Human-typed password / MFA (D-20) | the human's client during enrollment; the store (kind `password`); the **browser-fill executor** inside the browser worker (L5c) | fill operation with observation blackout; then store ciphertext | the HTTP executor (a `password` kind is *unresolvable* there by type, ADR 0005 §4), the model, DOM read-back after fill, recordings |
| TOTP secret | the store (part of kind `password`); the browser worker computing one code | code generation only | anywhere else; the code itself is never returned to the model |
| Workload / presenter private keys | the executor process that signs; the server signing key (`auth/env-bridge-signing-key.ts` pattern, separate key per audience) | process lifetime; rotated | guest filesystem/env/snapshots (S1 §3.1: root reads everything), Next.js request handlers |
| Grant (signed, one-use) | the issuer, the presenter, the replay store (nonce + `exp` only) | ≤ 15 min (ADR 0004 §2.3) | the model, the sandbox, logs beyond `grantId` |

## 6. Attack table

Rows A1–A12 are Codex's, each with our mitigation and the gate that must show the acceptance case green in the **one** adversarial harness (`packages/lib/src/agent-accounts/__tests__/adversarial/`). Rows B-* fold the B0 baseline's Mediums and Lows at their verified `file:line` (commit `632ba653a`), so the harness inherits every live finding. Highs are listed with their status.

### 6.1 Codex rows

| # | Attack | Mitigation | Required gate | ASI |
|---|---|---|---|---|
| A1 | Prompt injection → secret extraction | no raw-resolution interface; executors isolated from the model and sandbox; constrained outputs; canary secret never model-visible | G1b (no `resolve` in any tool), G2 canary, G6a/G6b/G6c browser | ASI01, ASI02 |
| A2 | Prompt injection → data exfiltration or harmful *authorized* action | provider scopes; in-provider resource restriction (repo/org/recipient/webhook target); approval bound to the digest; mediated egress; separate approval class for privilege expansion / recovery / token creation / bulk export | G2 (HTTP), G4 (relay), G6a (browser) | ASI01, ASI02 |
| A3 | Confused deputy across users, agents, drives | authenticated identity intersection (§4); explicit `use` grants; immutable account binding (copies/moves/transfers invalidate bindings); live revocation | G1a/G1b define + verify; G2 enforce | ASI03 |
| A4 | Sandbox → broker abuse | no guest→broker channel exists (S1); relay originates every credentialed op; argument-bound operations; quotas; parser limits | G4 (before any sandbox credentialed op) | ASI03, ASI07 |
| A5 | Grant replay, incl. restored-sandbox replay | presenter binding; ≤ 15 min expiry; atomic nonce consumption in Postgres shared across replicas; `(spriteInstanceId, generation)` binding; account/policy epochs | G1b (replay store), G4 (generation case) | ASI03, ASI07 |
| A6 | Malicious site during login | exclusive human-control mode: agent control **and observation** revoked; browser-verified frame destinations in trusted chrome; capture only approved session state; destroy login context, hydrate fresh | G6a (primitive), G6b (login) | ASI09 |
| A7 | Browser profile / CDP theft | worker in its own Sprite, CDP over a pipe (no port), profile never on the agent Sprite, no raw CDP/storage tools, no checkpoints of the browser holder | G6a | ASI02, ASI03 |
| A8 | Cookie/session theft from store or runtime | scoped readers per tenant; external keys (D-17); short session grants; revocation ends live sessions; runtime compromise stays a residual (§1 last clause) | G1b (adapter + identities), G6b | ASI03 |
| A9 | Insider, DB dump or **DB tampering** | separate store/IAM/keys; plane-held bindings (owner, tenant, origins, policy version) compared at resolve; independently authenticated owner consent for expansion; independent audit | G1b (bindings), G2 (consent step-up) | ASI03, ASI10 |
| A10 | OAuth refresh theft, races, issuer confusion | fixed provider endpoints; PKCE + state + issuer checks; refresh serialized per account; rotation with our CAS over `secret.version`; one restricted refresh worker; RFC 9700 rotation-replay → revoke the grant | G3 (before any OAuth enrollment through the plane) | ASI03, ASI08 |
| A11 | Recovery-email takeover | dedicated agent identity/alias; aliases cannot recover personal accounts; reset/OTP tokens resolved inside the plane, success reference returned; personal-mailbox filtering as defence in depth only | G7 | ASI09 |
| A12 | Onprem operator compromise | stated non-guarantee (§2.2); no gate blocks on onprem | G1a (this doc) | — |

### 6.2 B0 baseline rows (verified `file:line` at `632ba653a`)

**Highs** (not folded into the harness; tracked by decision):

| Finding | Status |
|---|---|
| ASI03/ASI04 `apps/web/src/app/api/integrations/providers/route.ts:105-108` admin gate never fires (any user creates a global provider) | **open — hotfix PR #2632 in flight (D-27)**; retire-by-hotfix once merged |
| ASI02 `packages/lib/src/integrations/execution/http-executor.ts:99-104` credentialed SSRF via `baseUrlOverride`, redirects followed | **open — hotfix PR open (D-28; green locally: lib 65/65, web 45/45, 8 mutation pairs; PR number to follow)**; retire-by-hotfix once merged. The G2 `http_request` executor MUST NOT inherit this executor (row B-16) |
| ASI02 `apps/web/src/lib/ai/tools/sandbox-git/tools/remote.ts:48-57` `git_push` `branch:"--force"` bypasses the push guard with the user's token | **open — hotfix PR #2635 open (D-28, CI pending)**; retire-by-hotfix once merged; retired structurally by the L4 relay (row A4) |

**Mediums and Lows** (each becomes a harness case or a gate exit check):

| # | Sev | ASI | Where | Attack | Mitigation / required gate |
|---|---|---|---|---|---|
| B-1 | Med | ASI03 | `services/sandbox/git-tool-runners.ts:162` → `local-env-sandbox-host.ts:176-185` + `env-bridge/decide-bind.ts:67-70` | acting user's GitHub token leaves the server inside the signed `grant_exec` frame to a *different* user's local daemon | widens Λ1; L4 removes token injection entirely (A4). Interim: D-25. Harness: "token-bearing exec refused on local substrate" (G4) |
| B-2 | Med | ASI03 | `git-tool-runners.ts:64-71` + `sandbox-git/core/command-specs/repo.ts:37-38` + `workspace-sandbox-runtime.ts:63-65` | shared drive-env Sprite: co-member reads `/proc/<pid>/environ`; `git_config --global` persists `credential.helper` for the next member's push | widens Λ1; retired by L4 (relay never hands Git the token). Harness: "shared-env co-member cannot observe another member's credentialed op" (G4) |
| B-3 | Med | ASI02 | `command-specs/remote.ts:14-16,24-26` + `tools/remote.ts:14-40` | `branch:"--upload-pack=<cmd>"` runs `<cmd>` with the token in env | flag-guard + L4. Harness row under A2 "argument-bound operations" (G4) |
| B-4 | Med | ASI09 | `packages/cli/src/env-bridge/ask.ts:34-35,59-60` | one human approval cached per `(userId, sessionId, op)` makes `argsHash` binding vacuous on the cached path → **Λ13** | account approvals are bound to the **digest**, never to `op` (ADR 0004 §4.3); "always" is bounded by scope/duration/limits. Harness: "approval for digest X does not authorize digest Y" (G1b) |
| B-5 | Med | ASI03 | `apps/web/src/app/api/agents/[agentId]/integrations/route.ts:202-210` + `ai/core/integration-tool-resolver.ts:77,81` | a personal (`visibility:'private'`) connection is exercised by anyone who can drive the agent page; any member grants a drive connection | **direct evidence for the view/use/manage/grant split**. `grant` requires owner (user-owned) or drive OWNER/ADMIN (drive-owned); user-owned accounts never silently attach to a shared agent (ADR 0004 §4). Harness: A3 substitution rows (G1b) |
| B-6 | Med | ASI09 | `integrations/providers/github.ts:1909-1913,1715-1719` | irreversible writes classified `'write'`, no per-call gate | operation classes `read / write / irreversible / privilege` (ADR 0004 §3.4); `irreversible` and `privilege` need concrete approval regardless of policy. Harness: "always-allow does not cover irreversible" (G1b); G3 reclassifies providers |
| B-7 | Med | ASI08 | `integrations/execution/http-executor.ts:154-159` | uncapped `Retry-After`; NaN → hot retry | executor limits: `Retry-After` ≤ timeout, NaN = backoff (G2 executor exit check) |
| B-8 | Med | ASI03/09 | `apps/web/src/lib/ai/tools/agent-tools.ts:60,78-84` | agent widens its own `enabledTools`/`systemPrompt`/`sandboxEnabled` → **Λ15** | editing an agent's instructions is `manage`-class on every account bound to it: bump `policyVersion` on the agent's accounts so standing grants lapse; widening behind a human step (ADR 0004 §4.4). Harness: "agent self-reconfig invalidates outstanding grants" (G2) |
| B-9 | Med | ASI06 | `ai/core/command-processor.ts:229-248` + `command-resolver.ts:305` | agent-writable command pages injected as "Follow these instructions" → Λ15 | out of this epic's files; recorded so G2's approval UI never renders text sourced from a page body as the *approval subject* (ADR 0004 §4.2: the subject is the digest's human rendering, generated from the canonical request, never model text) |
| B-10 | Med | ASI03 | `apps/web/src/lib/ai/tools/command-tools.ts:63,79,131` | drive-scoped MCP token escapes its ceiling for command CRUD | §4 asks the ceiling FIRST; the account decision consumes `isDriveWithinCredentialScope`, never a user-only helper. Harness: "scoped caller outside the account's drive reads it as nonexistent" (G1b) |
| B-11 | Low | ASI08 | `services/sandbox/sandbox-client/sprites.ts:749-760` | host timeout is a no-op when the WS is closed; no reaper | browser Sprites are destroyed (never hibernated) at grant expiry (S3 R15) — G6a exit check |
| B-12 | Low | ASI02 | `env-bridge/frame-codec.ts:71` + `cli/env-bridge/fs-runner.ts:260` | `fs_write` mode allows setuid bits | out of scope here; noted for the env-bridge |
| B-13 | Low | ASI07 | `cli/env-bridge/nonce-store.ts:52-53` | in-memory nonces; 30 s restart window | the account replay store is **Postgres, atomic, shared across replicas, survives restart** (ADR 0004 §2.4). Harness: "nonce consumed once across two verifiers with a restart between" (G1b) |
| B-14 | Low | ASI08 | `http-executor.ts:173-181` | non-idempotent 5xx retries | §2.4; executor retries idempotent operation classes only (G2) |
| B-15 | Low | ASI01 | `integrations/saga/execute-tool.ts:294-297` + `execution/validate-response.ts:32-38` | provider bodies reach the model verbatim | executor wraps every response as untrusted data and caps error text (G2) |
| B-16 | Low | ASI03 | `apps/web/src/app/api/user/integrations/route.ts:141-145` | OAuth authorize without PKCE | G3 builds enrollment with PKCE + state + issuer (A10) |
| B-17 | Low | ASI03 | `ai/tools/skill-tools.ts:77-83` | user-level helpers instead of `canActor*` | same rule as B-10 |
| B-18 | Low | ASI02 | `sandbox-git/core/command-specs/worktree.ts:22` | `git_diff base` becomes an option | flag-guard; retired by L4 relay for credentialed ops |
| B-19 | Low | ASI02 | `ai/core/tool-filtering.ts:13-143` | `WRITE_TOOLS` incomplete | out of scope; the account executor classifies by typed operation, not by tool name (ADR 0004 §3.4) |
| B-20 | Low | ASI08 | `ai/tools/workflow-tools.ts:84-100` + `workflows/workflow-executor.ts:640` | cron fan-out uncapped | account-use limits are part of the policy (ADR 0004 §4.1 `limits`); a cron run is an unattended run → needs a delegation with expiry (§3) |
| B-21 | Low | ASI01 | `ai/tools/web-search-tools.ts:391-396` | `web_fetch` returns bare attacker markdown | same as B-15 for the executor's responses |
| B-22 | Low | ASI06 | `ai/core/context-assembly.ts:252-254` | compaction summary re-enters as `user` | out of scope; recorded because approval requests must never be satisfied by model text (A2, ADR 0004 §4.2) |
| B-23 | Low | ASI04 | `ai/core/mcp-tool-converter.ts:233` + `page-chat-turn.ts:363` | unvalidated MCP tool descriptions | Λ12; out of scope |
| B-24 | Low | ASI03 | `ai/tools/actor-permissions.ts:286-291` | agent `manage` resolves to bare membership | account `manage`/`grant` for an agent-page-owned account requires drive OWNER/ADMIN of the *human* actor, never the agent's own membership (ADR 0004 §4) |

### 6.3 Rows this epic adds (not in Codex or B0)

| # | Attack | Mitigation | Gate |
|---|---|---|---|
| C1 | Lookalike / punycode / userinfo / port-confused origins | origin normalization (exact scheme+host+port, IDNA-to-ASCII, reject userinfo, reject wildcards by default) is a pure function with a table test (ADR 0004 §3.2) | G1b |
| C2 | DNS rebinding between authorization and connect | executor pins the validated address and repeats validation per redirect hop (reuses the `web_fetch` shell's per-hop discipline, not `web-fetch-ssrf.ts` alone) | G2 |
| C3 | `password` kind reaches the HTTP executor | unrepresentable: `ResolvableBy<'http-executor'>` excludes `password` at the type level and the adapter refuses at runtime (ADR 0005 §4) | G1b (type + mutation pair), G6c |
| C4 | Credential rotated mid-grant | grant binds `credentialVersion`; resolve of a different version is `version_mismatch` | G1b |
| C5 | Two overlapping refreshes / rotation race | per-account advisory lock + version-check-then-write; post-write verify; loser reconciles (ADR 0005 §5) | G3 |
| C6 | Deleting a store entry believed to revoke upstream | deletion semantics separate `brokerDenied` from `upstreamRevoked`; UI states which happened (ADR 0005 §5.3) | G2, G3 |
| C7 | Audit outage silently enables unaudited use | audit acceptance is durable **before** execute; unavailable audit ⇒ refuse (ADR 0004 §6) | G1b |

## 7. Deployment-mode trust statements

| Mode | Credential plane components | Trusted (a compromise is a credential-compromise event) | Not trusted (a compromise must not disclose plaintext) |
|---|---|---|---|
| `cloud` | Infisical managed cloud (US/EU AWS account); the executor processes (HTTP executor, relay runner, browser worker Sprites); the refresh worker | Infisical's runtime and administrators (Λ4); the executor hosts; Fly as the host of the executors; the providers | Next.js web processes (references only); the main Postgres (a dump yields nothing usable; tampering is A9); agent Sprites (Λ6); the browser *agent* context |
| `tenant` | same as cloud, one Infisical project per tenant domain; dedicated image | same as cloud | same as cloud; other tenants (per-tenant keys D-17, per-tenant identities per D-29) |
| `onprem` | operator-run Infisical (S2 §9 compose), executors on the operator's host | **the operator** (Λ11); everything the operator runs | nothing further can be excluded; the UI says so (§9 Λ11 copy). Enterprise-feature lapse turns audit/KMS off silently (S2 §2.3) — the executor refuses to serve when required features report absent |

Cross-mode: `isOnPrem()` gates the store backend choice; `isBillingEnabled()` is irrelevant to the plane. Never `!isCloud()`.

## 8. OWASP Agentic Top 10 mapping

| ASI | Threat here | Where it is handled |
|---|---|---|
| ASI01 goal hijack | injected instructions steer an authorized account into exfiltration or harm | A2; typed operations + digest-bound approval (ADR 0004 §3–4); executor responses wrapped as untrusted |
| ASI02 tool misuse | the credentialed HTTP/relay/browser tools used for unintended operations | A1, A2, A7; in-provider restrictions; operation classes; Highs D-28 |
| ASI03 identity & privilege abuse | confused deputy, ceiling escape, DB tampering, replay | A3, A5, A9, B-5, B-10; §3 principals; §4 intersection |
| ASI04 agentic supply chain | Infisical/Nango/browser substrate compromise (Λ12); tool-definition injection (D-27) | S2 §10 pins; per-gate review; Highs D-27 |
| ASI05 unexpected code execution | none in the plane (no eval; argv spawns only) | B0: does not apply; the plane adds no interpreter |
| ASI06 memory/context poisoning | model text used as approval subject or as an "approved" claim | ADR 0004 §4.2: approval subject is rendered from the canonical request; a model-reported approval has no authority |
| ASI07 insecure inter-agent comms | grant transport between issuer, presenter, executor | Ed25519-signed grants, audience-separated keys, replay store (ADR 0004 §2); server→guest channel only (ADR 0006) |
| ASI08 cascading failures | refresh storms, retry storms, uncapped fan-out | B-7, B-14, B-20; limits in policy; refresh serialization (ADR 0005 §5) |
| ASI09 human-agent trust exploitation | fake approvals, cached approvals, login-time deception | A6, B-4, B-6; exclusive human-control mode; approval bound to digest with a human-readable rendering |
| ASI10 rogue agents | an agent redirecting its own standing authority; unaudited use | B-8 (Λ15); audit-before-execute (C7); revocation ends live sessions |

## 9. Liability register in prose (Control Board §0), with user-facing copy for accepted liabilities

Statuses are as of 2026-09-15; the Control Board is the ledger, this section is the narrative the product must be able to say out loud.

- **Λ1 — the user's GitHub OAuth token is exported into every sandbox git exec** (`git-tool-runners.ts:15,64-71`). *Accepted* by **D-23** until the L4 relay; B0 widened it to another user's local daemon (B-1) and to every collaborator on a shared drive environment (B-2), which D-23's wording did not name; **D-25** proposes bounding it to 1-hour installation tokens meanwhile. Target: bounded (D-25) → retired (L4). **Copy:** "Git commands in a sandbox currently run with your GitHub connection's token inside the sandbox. Anyone who can run code in that sandbox — including other members sharing a drive environment — could read it. We are replacing this with a relay that never places the token in the sandbox."
- **Λ2 — every integration/OAuth token sits in the main Postgres under one global `ENCRYPTION_KEY`** (nine decrypt sites, B0 §Λ2). *Open* → retired at L3. No user copy until L3 ships; the security claim is explicitly scoped until the last path moves.
- **Λ3 — custody of third-party passwords + TOTP** (D-20). *Accepted* → bounded: external store only, executor-only resolution, dedicated-agent-account default, explicit acknowledgment for a personal login (`agent_accounts.acknowledgment`, ADR 0005 §4), vault-rule fill in L5c, breach runbook coverage. **Copy (add-account, `password` kind):** "You are giving your agent a password. PageSpace stores it encrypted in a separate credential vault and only ever fills it into a login form inside an isolated browser, with the agent unable to watch. The site you log into will receive the password, as it would from you. We recommend a dedicated account for your agent rather than your personal login. [ ] I understand this is my personal login."
- **Λ4 — Infisical (SaaS) is a trusted custodian.** *Accepted* (D-21) → bounded by per-tenant scoped identities (**D-29** decides the mapping; ADR 0005 §3 recommends). **Copy (security page):** "Credentials are held by Infisical, a SOC 2 Type II secrets manager, under a key unique to your workspace. Infisical's operators, and the servers that use a credential on your behalf, are trusted; a breach there is a breach of your credentials and we will notify you under our breach runbook."
- **Λ5 — Nango's own Postgres would hold OAuth tokens.** *Open* → retired if **D-24** = A (S2 recommends drop; never provisioned). ADR 0005 §5 is parameterized on it.
- **Λ6 — the sandbox is a hostile principal.** *Open* → bounded at L4: no guest→server channel exists (S1), grants bind instance+generation, the relay never hands Git the token.
- **Λ7 — browser profile/cookies reachable from the agent runtime.** Not built → bounded at L5a: worker in its own Sprite, CDP over a pipe.
- **Λ8 — captured sessions are as powerful as passwords.** *Accepted* → bounded at L5b. **Copy (session capture):** "A saved login session lets your agent act as you on this site without your password, until you revoke it here or the site signs it out. Treat it like a password."
- **Λ9 — recovery authority reaching an agent.** Not built → bounded at L6.
- **Λ10 — an authorized site can echo or mint credentials.** *Accepted* (G1a, §2.1). **Copy (add-account, every kind):** "Once your agent uses this account on an allowed site, that site can see the credential, as it could if you used it yourself. PageSpace cannot prevent a site from displaying or copying it."
- **Λ11 — the onprem operator controls broker, store and host.** *Accepted* (D-21, §2.2). **Copy (onprem settings):** "On a self-hosted PageSpace the operator of this installation can access any credential your agents use. Only store credentials here that you would trust that operator with."
- **Λ12 — vendor supply chain.** *Open* → bounded by S2 §10 pins and a review-agents ASI04 pass per gate.
- **Proposed by B0, pending the orchestrator's decision to add rows:** Λ13 human-approval granularity (B-4) — answered structurally here by digest-bound approvals; Λ14 provider/tool definitions are admin-only integrity data (D-27 hotfix); Λ15 an agent can redirect its own standing authority (B-8, B-9) — answered by `policyVersion` bump + `manage` class; Λ16 web-process SSRF with credentials attached (D-28) — the G2 executor must not inherit `http-executor.ts`.

## 10. Open decisions this document is parameterized on

| Decision | What changes here | What does not |
|---|---|---|
| **D-24** Nango | if A (drop): Λ5 retired, the refresh worker is ours (ADR 0005 §5.1). If isolate: the refresh worker is Nango's inside a second plane and A10's "one restricted refresh worker" names it | the store adapter (Infisical), the grant, the digest, the permissions |
| **D-25** interim Λ1 bounding | Λ1 status accepted → bounded; row B-1/B-2 blast radius shrinks to one hour | L4 still retires the injection |
| **D-29** identity cost | which of A/B/C in ADR 0005 §3 is chosen decides Λ4's target (bounded vs accepted) and the tenant→identity mapping | per-tenant *keys* (free at every tier), the adapter interface, `TenantId` derivation |

Nothing in §1–§5 depends on these three; that is what makes the shapes freezable now.
