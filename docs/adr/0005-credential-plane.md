# ADR 0005 — The Credential Plane: store adapter, keys, identities, account reference row, extend-vs-new

- **Status:** Proposed (L1·G1a contract — freezes the plane's interface; G1b implements the adapter against Infisical, G2 generates the migration)
- **Date:** 2026-09-15
- **Deciders:** Agent Accounts & Credential Broker epic (`j471yhv7p3abea7mlxrchdu1`), Control Board `pzutwyfnczxwkd61jhk3nya0` §0–§1
- **Related:** threat model §5 (residency), §7 (trust per mode), §10 (open decisions); ADR 0004 (what a verified grant is); ADR 0006 (relay presenter). Spike S2 is the vendor evidence.
- **Frozen files:** `packages/lib/src/agent-accounts/store/store-adapter.ts`, `packages/db/src/schema/agent-accounts.ts` (reference row; the `pgTable` + migration are G2's).
- **Open decisions this ADR is parameterized on:** **D-24** (Nango — §5 is written so the store adapter is Infisical either way; only the refresh worker's owner changes), **D-29** (per-tenant identity cost — §3 names the three options and recommends; it does not decide).

## Question

Where does credential plaintext live, under which keys, readable by which identity, through what interface, and what happens to the three existing tables (`integration_connections`, `integration_tool_grants`, `global_assistant_config`) that hold or grant credentials today?

## Decision (summary)

1. **Backend: Infisical managed cloud (D-21).** One Infisical **project per tenant domain** so every tenant has its own data key by construction (D-17, S2 §2.1). The main Postgres holds **references only**; there is no secret column anywhere in it.
2. **Store adapter interface**: `put / resolve / revoke / rotate / delete` with **our own compare-and-swap** — Infisical has read-side versions but no write-side CAS (S2 §2.4), so CAS is version-check-then-write under a per-secret Postgres advisory lock, with post-write verification. Deletion semantics distinguish *broker denied* from *upstream revoked*.
3. **Identity model**: one **reading identity per tenant project**, never an identity that can read every tenant (Λ4). The web process holds **no** store identity. D-29 decides how tenants map onto billed identities; §3.3 recommends **A** (paid tiers get a dedicated identity; free tier shares a pooled identity path-scoped per tenant) and states what each option makes Λ4.
4. **Account reference row** (`agent_accounts`): kinds `api_key | bearer | oauth2 | session | password`; `acknowledgment` column; `credentialVersion` + `policyVersion`; owner is `user` **or** `agent page` (D-16); **`password` is resolvable only by the browser-fill executor**, enforced by type and at the adapter.
5. **Extend-vs-new: new tables.** `integration_connections.credentials` is migrated *into* the plane in G3 and the column dropped; `integration_tool_grants` is superseded by account bindings + delegations; `global_assistant_config.enabledUserIntegrations` becomes a list of `accountId`s. None of the three is extended with new secret-bearing or authority-bearing columns.
6. **OAuth lifecycle** runs in **one restricted refresh worker** that is the only holder of a refresh-capable identity — ours if D-24 = drop (S2 recommendation), Nango's inside an isolated second plane otherwise. Either way it speaks to the plane through this adapter and serializes with this CAS.

---

## 1. Verified ground truth

- **Today's residency** (B0 §Λ2): key = `process.env.ENCRYPTION_KEY` scrypt-derived once per process (`packages/lib/src/encryption/encryption-utils.ts:20-25,108-110`); nine decrypt sites, the two that matter for the plane being `integrations/saga/execute-tool.ts:202` (decrypts inside the Next.js/lib saga, then `applyAuth`) and `services/sandbox/github-token.ts:27` (decrypts, then exports into the sandbox env — Λ1). `refreshOAuthToken` has zero callers and `expiresAt` is never read (`integrations/oauth/oauth-handler.ts:163`).
- **The three tables** (`packages/db/src/schema/integrations.ts`): `integration_connections` (`:99` region) has `credentials: jsonb` "encrypted before storage", a `userId XOR driveId` CHECK, a `visibility` enum for user connections, `baseUrlOverride` (the D-28 SSRF input), and `oauthState`; `integration_tool_grants` (`:175` region) is `(agentId, connectionId, allowedTools, deniedTools, readOnly, rateLimitOverride)` with no grantor, no expiry, no policy version; `global_assistant_config` (`:217` region) holds `enabledUserIntegrations: jsonb` and `driveOverrides`; `integration_audit_log` (`:245` region) logs `toolName`, `inputSummary`, `responseCode` per call with no principal beyond `userId/agentId`.
- **Infisical facts** (S2 §2, quoted from vendor docs 2026-09-14): AES-256-GCM; root key → internal KMS root key → per-org and per-project data keys ("cryptographic isolation between tenants"); external per-project KMS is Enterprise; machine identities are permission-based and billed per identity ($20 Pro / $40 Advanced per identity per month); `GET /api/v4/secrets/{name}` returns `secret.version` and `secretValue`; `PATCH` has **no** conditional parameter; every change creates a new version; audit logs are Pro+ and after-the-fact; Universal Auth has client-secret TTL, max-uses and trusted-IP knobs; OIDC auth exists.
- **Nango facts** (S2 §1): tokens stay in Nango's Postgres (only the DEK can be KMS-wrapped); encryption optional; no key rotation; reader identity is a per-environment key that reads every connection and `GET /connections/{id}` returns plaintext. Under the custody rule it is a plane or it is not used (D-24).
- **Precedents in the repo** for the plane's own metadata: single-use consumption by conditional update across replicas (`packages/db/src/schema/dev-preview-grants.ts`); advisory locks (`packages/db/src/advisory-lock.ts`); the per-tenant envelope pattern already argued in `docs/security/pii-encryption-design.md` §"Key management" (domain-separated keys; one secret to rotate); the ABA guard `machine_sprite_reclaims.spriteInstanceId`.
- **Codex's plane requirements** (`km6yrydf0sc08g6ikoikno7f`): "include versioned writes/CAS, rotation, revocation state, and deletion semantics — not just put / resolve / revoke"; "deleting a stored cookie does not invalidate the upstream session; store TTLs do not necessarily revoke third-party API keys. Track broker denial and upstream revocation separately"; "Next.js holds metadata only: no store identity, no keys"; "credential-plane records must independently bind owner, tenant, origins, and policy versions".

## 2. Decision D1 — the store adapter interface (frozen; `store/store-adapter.ts`)

### 2.1 Callers

Exactly three executor classes may call `resolve`: the HTTP executor (G2), the relay runner (G4), the browser worker (G6a–c). The refresh worker calls `resolve` for `oauth2` only and is the only caller of `rotate`. Next.js routes call `put` (through the ingress handler), `revoke`, `delete`, and `describe` — never `resolve`. This is enforced by **audience**: every adapter call carries the verified grant (ADR 0004) whose `aud` must match the caller's channel, and `resolve` is unrepresentable for a grant whose `aud` is not an executor channel.

### 2.2 Operations

| Op | Signature (options object; result unions, never throws for expected outcomes) | Semantics |
|---|---|---|
| `put` | `({ ref: SecretRef; material: SecretMaterial; expectedVersion: CredentialVersion \| null; bindings: PlaneBindings; identity: StoreIdentity }) → PutResult` | creates (`expectedVersion: null`) or replaces. **CAS**: refuses with `version_conflict` if the current version ≠ `expectedVersion`. Writes `bindings` beside the material as secret metadata. Returns the new `CredentialVersion` |
| `resolve` | `({ ref; version: CredentialVersion; grant: VerifiedGrant; identity }) → ResolveResult` | returns material **only** if `version` is the current version **and** the grant's `(tenantId, accountId, credentialVersion)` equal the ref's **and** the stored `bindings` agree with the grant's `(tenantId, ownerRef, policyVersion)` **and** `grant.aud` may resolve this `kind` (§4.3). Anything else is one of `version_mismatch \| binding_mismatch \| kind_not_resolvable \| revoked \| not_found` |
| `rotate` | `({ ref; expectedVersion; next: SecretMaterial; bindings; identity }) → RotateResult` | `put` with the extra rule that the previous version stays readable for `ROTATION_GRACE_MS` (grants in flight) and is then unreadable; only the refresh worker's identity may call it |
| `revoke` | `({ ref; reason: RevokeReason; identity }) → RevokeResult` | marks the ref **broker-denied**: every future `resolve` returns `revoked`; the material is retained for `REVOKE_RETENTION_MS` so an upstream-revocation attempt can still be made; bumps nothing upstream |
| `delete` | `({ ref; identity; upstream: UpstreamRevocation }) → DeleteResult` | removes the material and all versions. `upstream` records whether an upstream revocation was attempted and its outcome (`'revoked' \| 'unsupported' \| 'failed' \| 'not_attempted'`); the result carries both facts so the UI can say "removed from PageSpace; the key is still valid at the provider" |
| `describe` | `({ ref; identity }) → DescribeResult` | version, kind, `bindings`, timestamps, revocation state — **never material** |

`SecretRef = { tenantId; accountId; kind }` maps to the Infisical path `/<tenantProject>/<accountId>/<kind>` (one project per tenant, §3). `PlaneBindings = { tenantId; ownerRef; allowedOrigins (canonical); policyVersion; kind }` — the independent binding Codex asked for (threat-model A9). `StoreIdentity` is the tenant-scoped machine identity handle the executor holds; it is a parameter so a test can pass a wrong-tenant identity and watch `resolve` fail.

### 2.3 Our CAS (Infisical has none on the write side)

```text
lock  = pg_advisory_xact_lock(hash(tenantId, accountId, kind))     -- plane metadata DB, not the app DB
read  = infisical GET secret → { version: v }
check = v == expectedVersion  else version_conflict
write = infisical PATCH/POST secret (material + bindings)
verify= infisical GET secret → { version: v' }; v' == v + 1 and metadata == bindings else write_unverified
commit= plane metadata row { ref, currentVersion: v', previousVersion: v, rotatedAt }
```

The lock serializes writers per secret across replicas; the verify catches an overlapping write that slipped past the lock (a second Infisical writer that is not us). `write_unverified` is a refusal to *report success*, not a rollback — the material may have landed; the reconciler (G3) resolves it by re-reading and re-binding. The pure decision `decideStoreWrite({ expectedVersion, observedBefore, observedAfter })` returns `commit | version_conflict | write_unverified` and is table-tested; the adapter only acts on it.

### 2.4 Bindings are compared at resolve

`resolve` compares the stored `PlaneBindings` with the grant's claims using `secureCompare` over a canonical JSON. A main-DB writer who reassigns `agent_accounts.ownerUserId` or widens `allowedOrigins` produces a grant whose bindings disagree with the plane's copy → `binding_mismatch`. Widening therefore requires the `put`/`rotate` path with step-up (ADR 0004 §4.4), which rewrites the bindings under the owner's authenticated consent.

### 2.5 Plane metadata tables (G1b creates; main DB is acceptable for metadata because none of it is secret and all of it is cross-checked against the store)

`agent_account_grant_nonces` (ADR 0004 §2.4), `agent_account_approvals`, `agent_account_delegations`, `agent_account_secret_versions` (`ref`, `currentVersion`, `previousVersion`, `rotatedAt`, `revokedAt`, `revokeReason`), `agent_account_audit` (ADR 0004 §5 shape). The advisory-lock namespace is the plane's, distinct from `advisory-lock.ts`'s existing keys.

## 3. Decision D2 — keys, tenants and identities

### 3.1 Tenant domain (`TenantId`, derived, never chosen)

`deriveTenantId({ owner })` is pure: `user:<userId>` for a user-owned account, `drive:<driveId>` for an agent-page-owned account (D-16). A drive is not a tenant by itself; a user-owned global-assistant account sits outside every drive. Drive-shared accounts ("later", D-16) will map to `drive:<driveId>` when they arrive, so the id space does not change. One Infisical project per `TenantId`, created on first `put` for that tenant by the provisioning identity (the only identity allowed to create projects; it cannot read secrets).

### 3.2 Keys (D-17)

Per-project data keys are Infisical's, free at every tier, and give per-tenant cryptographic isolation by construction. The wrapping hierarchy (root → internal KMS root → project key) lives in Infisical, never in the main DB or the web process. External per-project KMS (Enterprise) is an upgrade path, not a v1 dependency. There is no PageSpace-side field encryption of credential material: inventing a second envelope on top of the store's is exactly what Codex warned against ("use the chosen store's supported key hierarchy rather than inventing field encryption").

### 3.3 Reading identities — the three D-29 options, named; recommendation, not decision

The bar (Λ4): *no identity can read every tenant*. Identities are billed per identity (S2 §2.6), so the mapping is a cost fork the founder decides (D-29).

| Option | Mapping | What Λ4 becomes | Cost shape (S2 §8.1 list prices) | Trade |
|---|---|---|---|---|
| **A — dedicated identity for paid tiers; pooled, path-scoped identity for the free tier** | paid tenant → one identity restricted to its project; free tenants → one shared identity whose role carries `secretPath` conditions per tenant path (`/<tenantProject>/**` is not possible across projects, so the pooled identity holds one *project* per free tenant with a role scoped to that project — the pool is the identity, the scope is per project role assignment) | **partially bounded**: a compromise of the pooled identity reads every *free* tenant; paid tenants are isolated | $20–40 × paid tenants + a handful of pooled identities | the blast radius is stated per tier in the threat model; the upgrade path to B is a re-assignment, no data move |
| **B — one identity per tenant regardless of tier** | every tenant project → its own identity | **bounded** (the cleanest reading of Λ4) | $20–40 × all tenants: $2k/mo at 100, $20k/mo at 1k | does not scale past a few hundred tenants without an Enterprise quote |
| **C — one executor identity, isolation by project-path conditions only** | one identity with a role over every project, conditions on `secretPath` | **accepted, not bounded**: one credential reads everything | ≈ 3 identities total | cheapest; leaves Λ4 exactly where D-21 accepted it |

**Recommendation: A**, with two riders. (i) The *executor* never holds a pooled identity directly: it requests a short-lived Universal Auth client secret (TTL ≤ grant lifetime, max-uses 1) or an OIDC-audience-bound token minted by the authority per grant, so a leaked executor credential is one tenant for one grant. (ii) The pooled identity's role is re-assigned per tenant project by the provisioner at `put` time and removed at tenant deletion, so the pool's reach is the set of *currently free* tenants, not "everything ever". Under A the threat model's Λ4 row reads "bounded for paid tenants; shared blast radius across free tenants, stated". If the founder chooses B or C, only §3.3 and the Λ4 copy change; the adapter, `SecretRef`, `TenantId` and the CAS do not.

### 3.4 Where the web process stands

`apps/web` holds **no** store identity, no root key, no unrestricted signing key. Its only plane credentials are: the ingress handler's *write-only* identity for `put` (cannot `resolve`), and the authority's grant-signing key held by the authority process. The executors hold reading identities. Verified by a test that the web bundle's env schema (`config/env-validation.ts`) has no `INFISICAL_*_READ*` variable and that `resolve` is not exported from any module `apps/web` imports.

## 4. Decision D3 — the account reference row (`packages/db/src/schema/agent-accounts.ts`; G1a defines, G2 generates)

### 4.1 Columns

| Column | Type | Rule |
|---|---|---|
| `id` | `AccountId` (cuid2) | |
| `kind` | `AccountKind = 'api_key' \| 'bearer' \| 'oauth2' \| 'session' \| 'password'` | one canonical union; `Record<AccountKind, …>` for per-kind data |
| `ownerKind`, `ownerUserId`, `ownerAgentPageId` | `'user' \| 'agent_page'`; exactly one FK set (CHECK, as `integration_connections_scope_chk`) | D-16 |
| `tenantId` | derived from the owner at insert; immutable (a CHECK/trigger in G2 refuses updates) | §3.1 |
| `name`, `providerSlug` | display; `providerSlug` selects the operation catalogue (`null` = generic origin) | |
| `allowedOrigins` | canonical origins (ADR 0004 §3.2), non-empty | invariant 2 |
| `auxiliaryOrigins` | canonical origins the human approved at capture (S3 §3.5) | may be empty |
| `resourceRestrictions` | `jsonb` per provider (repo/org/recipient/webhook allowlists) | ADR 0004 §3.2 `resources` |
| `approvalPolicy` | `AccountApprovalPolicy \| null` | ADR 0004 §4.3 |
| `credentialVersion` | int, mirrors the store's current version | bumped by `put`/`rotate` |
| `policyVersion` | int | bumped by every authority-relevant change (ADR 0004 §4.4) |
| `acknowledgment` | `AccountAcknowledgment = 'dedicated_agent_account' \| 'personal_login_acknowledged'` | **required**; the add-account UI defaults to `dedicated_agent_account` and requires an explicit tick for `personal_login_acknowledged` (Λ3 copy, threat-model §9). A `password` or `session` kind with `dedicated_agent_account` still stores the acknowledgment so the UI can show which one was given |
| `sessionFormat` | `'cookie-jar-v1' \| 'storage-state-v1' \| 'human-relogin' \| null` | non-null iff `kind = 'session'` (S3 §5) |
| `status` | `'active' \| 'revoked' \| 'needs_reauth' \| 'deleted'` | `revoked` = broker-denied; `needs_reauth` = upstream expired/invalid |
| `upstreamRevocation` | `'not_attempted' \| 'revoked' \| 'unsupported' \| 'failed' \| null` | set by `delete` (§2.2) |
| `lastUsedAt`, `createdAt`, `updatedAt`, `revokedAt` | timestamps (UTC) | |

**There is no secret column, no `credentials` jsonb, no `oauthState`, no `baseUrlOverride`.** Every value that is not display metadata is a version or a policy. A test greps the schema file for `credentials`, `secret`, `token`, `password` as *column names* and fails on any hit that is not `kind`.

### 4.2 Per-kind material (store side only; `SecretMaterial = Record<AccountKind, …>` discriminated)

| Kind | Material | Resolvable by (`ResolvableBy<K>`) |
|---|---|---|
| `api_key` | `{ value }` + placement descriptor (header/query name) | `http-executor`, `relay-runner` |
| `bearer` | `{ token; expiresAt \| null }` | `http-executor`, `relay-runner` |
| `oauth2` | `{ accessToken; accessExpiresAt; refreshToken \| null; scopes; issuer; tokenEndpoint }` | `http-executor`, `relay-runner` (access token only); `refresh-worker` (refresh token) |
| `session` | `{ format; cookies; storage? }` per S3 §5 | `browser-worker`; `http-executor` only under a separate `session-http` permission on the account (default off) |
| `password` | `{ username; password; totpSecret \| null }` | **`browser-worker` only** (the fill executor, L5c). The type `ResolvableBy<'http-executor'>` excludes `password`; the adapter additionally refuses with `kind_not_resolvable`. Mutation pair required (Control Board §7.4) |

### 4.3 Bindings for agent pages

`agent_account_bindings (accountId, agentPageId, boundBy, boundAt, revokedAt)` — a user-owned account may be bound to an agent page the owner can `grant` on; the binding does **not** make the account usable by other humans driving that agent (ADR 0004 §4.1 `use`). Agent-page-owned accounts are implicitly bound to their owner page.

## 5. Decision D4 — OAuth lifecycle (parameterized on D-24)

### 5.1 If D-24 = A (drop Nango — S2's recommendation)

One restricted **refresh worker** (`refresh-worker.ts`, an I/O file; decisions in `decide-refresh.ts`): the only holder of an identity that can read `oauth2.refreshToken`. Per account: advisory lock → `resolve` current version → refresh at the fixed, pinned token endpoint with PKCE/state/issuer checks → `rotate` under CAS → release. Rotation-replay (a rotated refresh token presented again) revokes the account's grant and sets `needs_reauth` (RFC 9700 §2.2.2). Crash mid-refresh is recovered by `write_unverified` reconciliation (§2.3). Λ5 is retired (never provisioned). This is the G3 scope the epic already words as "ours otherwise".

### 5.2 If D-24 = isolate Nango as a second plane

Nango runs on its own 6PN with its own Postgres, Redis, KMS-wrapped DEK and one environment per tenant (S2 §7.1); it is the refresh worker for `oauth2` kinds it manages; **our** adapter still fronts it: `resolve` for those accounts calls Nango's proxy path, never `GET /connections/{id}`, and Nango's environment key is a reading identity scoped to one tenant environment (Λ4 applies to it). The grant, digest, bindings and audit are unchanged. §5.1's `decide-refresh.ts` is not built; its assertions move to an integration test against the isolated Nango.

### 5.3 Either way

`delete` never implies upstream revocation; the UI copy states which of the two happened. Provider tool catalogues are reclassified to `OperationClass` in G3 (ADR 0004 §3.4).

## 6. Decision D5 — extend-vs-new ruling

| Table | Ruling | Why | Gate |
|---|---|---|---|
| `integration_connections` | **new table `agent_accounts` (§4); migrate then drop `credentials`, `oauthState`, `baseUrlOverride`** | its `credentials` jsonb is Λ2 itself; `baseUrlOverride` is the D-28 SSRF input and has no place in a pinned-origin model (the origin *is* the base); `visibility` is replaced by explicit `use`/`grant` (B0 B-5); its `(userId, providerId)` uniqueness forbids two accounts on one provider, which dedicated agent accounts need | G2 creates; G3 migrates each row's material into the plane, sets `credentialVersion`, and removes the nine decrypt sites (grep proof); erasure (`compliance/erasure/revoke-integration-tokens.ts:33`) becomes `delete` with `upstream` |
| `integration_tool_grants` | **superseded by `agent_account_bindings` + `agent_account_delegations` + `approvalPolicy`** | it names no grantor, no expiry, no policy version, and resolves by `agentId` alone (B0 B-5); `allowedTools/deniedTools/readOnly` become `resourceRestrictions` + operation classes | G2 (new), G3 (migrate, then drop) |
| `global_assistant_config` | **extend, minimally**: `enabledUserIntegrations` becomes `enabledAccountIds: AccountId[]`; no other change | it is a per-user preference list, not an authority; use still goes through `decideAccountAccess` with the acting human = owner | G2 |
| `integration_audit_log` | **superseded by `agent_account_audit`** (ADR 0004 §5) for credentialed operations; left in place for non-credentialed integration calls until G3 | it lacks the principal set and the digest | G2 writes the new one; G3 reroutes |

Executors: the credential-bearing part of `integrations/saga/execute-tool.ts:198-230` moves behind the plane in G2 (`applyAuth` is reused as a pure formatter inside the executor; the decrypt location is not reused). The G2 `http_request` executor is **new** and does not inherit `integrations/execution/http-executor.ts` (D-28, threat-model B-16).

## 7. Decision D6 — operational posture of the plane (Codex "infrastructure" row)

Executors run as their own processes/Sprites with: no request-body telemetry; core and heap dumps disabled; bounded lifetimes (a browser Sprite is destroyed at grant expiry; an HTTP executor process recycles on a fixed cadence); credential ingress on a dedicated listener excluded from tracing and replay; secret-free logs (the audit record carries names and hashes only). The authority's signing key and the executors' identities are delivered as process secrets, never through the main DB. Onprem: the executor refuses to serve when Infisical reports the enterprise features it depends on as absent (licence lapse, S2 §2.3).

## 8. Fail-closed posture (every line is a RED test)

| # | Situation | Behaviour |
|---|---|---|
| F1 | `resolve` with a grant whose `aud` is not an executor channel | unrepresentable by type; adapter returns `kind_not_resolvable` if reached |
| F2 | `resolve` of kind `password` by any channel but `browser-worker` | `kind_not_resolvable` |
| F3 | `resolve` with `version ≠ current` (rotation happened) | `version_mismatch`; the previous version is readable only inside `ROTATION_GRACE_MS` and only by a grant that named it |
| F4 | Stored bindings ≠ grant bindings (owner/tenant/origins/policyVersion) | `binding_mismatch` |
| F5 | Identity scoped to tenant X resolving a ref in tenant Y | `not_found` (the store refuses; the adapter does not distinguish) |
| F6 | `put`/`rotate` with `expectedVersion ≠ observed` | `version_conflict`; nothing written |
| F7 | Post-write verify disagrees | `write_unverified`; success is not reported; reconciliation runs |
| F8 | Advisory lock unavailable / metadata DB unreachable | refuse the write; never write unlocked |
| F9 | Store unreachable at `resolve` | `store_unavailable`; the executor does not act; no cached plaintext is served |
| F10 | `revoke`d ref resolved | `revoked`, regardless of version |
| F11 | `delete` with upstream revocation `failed`/`unsupported` | material removed; result carries the upstream fact; UI states it |
| F12 | `agent_accounts` row updated to change `tenantId` | refused (immutable) |
| F13 | Web process attempts `resolve` | not compiled: `resolve` is not exported to any module the web bundle imports; an env-schema test proves no reading identity is configured there |
| F14 | Onprem store reports required enterprise features absent | executor refuses; alert |

## 9. Pure-function signatures (G1b implements behind `*-adapter.ts` / `*-repository.ts` / `*-worker.ts`)

```ts
// store/store-adapter.ts — the interface (type only; G1b: infisical-store-adapter.ts)
export type StoreAdapter = {
  readonly put: (input: PutInput) => Promise<PutResult>;
  readonly resolve: <C extends ExecutorChannel>(input: ResolveInput<C>) => Promise<ResolveResult<ResolvableBy<C>>>;
  readonly rotate: (input: RotateInput) => Promise<RotateResult>;
  readonly revoke: (input: RevokeInput) => Promise<RevokeResult>;
  readonly delete: (input: DeleteInput) => Promise<DeleteResult>;
  readonly describe: (input: DescribeInput) => Promise<DescribeResult>;
};

// store/decide-store-write.ts (G1b) — the CAS decision
export type DecideStoreWrite = (input: { expectedVersion: CredentialVersion | null;
  observedBefore: CredentialVersion | null; observedAfter: CredentialVersion | null;
  bindingsAfter: PlaneBindings | null; bindingsWritten: PlaneBindings }) =>
  { outcome: 'commit'; version: CredentialVersion } | { outcome: 'version_conflict' } | { outcome: 'write_unverified' };

// store/decide-resolve.ts (G1b) — every refusal in §8 F1–F5, F10 as data
export type DecideResolve = (input: { grant: VerifiedGrant; ref: SecretRef; stored: StoredSecretFacts | null;
  now: number; rotationGraceMs: number }) => ResolveDecision;

// tenant.ts
export type DeriveTenantId = (input: { owner: AccountOwnerRef }) => TenantId;

// identity/plan-store-identity.ts (G1b; parameterized on D-29)
export type PlanStoreIdentity = (input: { tenantId: TenantId; tier: 'free' | 'paid'; model: 'A' | 'B' | 'C' }) =>
  { identity: 'dedicated' | 'pooled' | 'single'; projectRoleScope: TenantId; blastRadius: 'tenant' | 'tier' | 'all' };

// oauth/decide-refresh.ts (G3, if D-24 = A)
export type DecideRefresh = (input: { material: OAuth2Material; now: number; marginMs: number;
  lockHeld: boolean; lastAttempt: RefreshAttemptFact | null }) =>
  { action: 'refresh' } | { action: 'skip'; reason: 'fresh' | 'locked' | 'backoff' } | { action: 'needs_reauth'; reason: 'no_refresh_token' | 'rotation_replay' | 'exhausted' };
```

## 10. Testable assertions (each becomes a RED test in G1b; G3 for 12–14)

1. Given the `agent_accounts` schema file, no column name matches `/credential|secret|token|password/` except the `kind` enum literal (a source-level test).
2. Given `deriveTenantId` for a user-owned account, returns `user:<userId>`; for an agent-page-owned account, `drive:<driveId>`; the same owner always derives the same id (idempotent, pure).
3. Given `decideResolve` with a `password` kind and channel `http-executor`, returns `kind_not_resolvable`; with `browser-worker`, `ok`. The type `ResolvableBy<'http-executor'>` does not include `password` (`// @ts-expect-error` test).
4. Given `decideResolve` with `version` one behind current inside `rotationGraceMs`, `ok` for a grant that named the old version; outside it, `version_mismatch`.
5. Given stored bindings whose `policyVersion` differs from the grant's, `binding_mismatch`; given a changed `ownerRef`, the same; comparison is over canonical JSON (key order irrelevant).
6. Given `decideStoreWrite` with `observedBefore ≠ expectedVersion`, `version_conflict`; with `observedAfter ≠ observedBefore + 1` or bindings mismatch, `write_unverified`; else `commit` with the new version.
7. Given the Infisical integration test (sandbox project, synthetic material): `put` → `describe` returns the version and bindings and **never** the material; `resolve` with the wrong-tenant identity → `not_found`; `resolve` after `revoke` → `revoked`; `delete` → subsequent `describe` → `not_found`.
8. Given two concurrent `rotate` calls with the same `expectedVersion` against the real store, exactly one commits and the other returns `version_conflict` (the advisory lock test, `*.integration.test.ts` against `:5433`).
9. Given `delete` whose upstream revocation returns `unsupported`, the result carries `{ removed: true, upstream: 'unsupported' }` and the row's `upstreamRevocation` reads the same.
10. Given `planStoreIdentity` with model A and tier `free`, `blastRadius: 'tier'`; model A and `paid`, `'tenant'`; model B, `'tenant'` for both; model C, `'all'` — so the threat-model Λ4 sentence can be generated from the chosen model.
11. Given the web app's server env schema, no variable grants a store *reading* identity; given the web bundle's import graph, `resolve` is unreachable (a knip/tsc-level test: the adapter module is not in `apps/web`'s dependency closure).
12. Given `decideRefresh` with a rotated refresh token presented a second time (`lastAttempt.rotationReplayed`), `needs_reauth('rotation_replay')`; with `lockHeld: true`, `skip('locked')`; with `accessExpiresAt - now > marginMs`, `skip('fresh')`.
13. Given a crash injected between `write` and `verify` in the refresh worker's integration test, the reconciler ends with `currentVersion` equal to the store's and no grant able to resolve the stale version.
14. Given the migration of an `integration_connections` row, its material is `describe`-able in the plane at `credentialVersion 1`, the source column is null, and `git grep decryptCredentials` returns zero call sites outside `packages/lib/src/encryption/` (G3 exit).
15. Mutation pairs: break the `aud` gate in `decideResolve`, the `kind_not_resolvable` rule for `password`, the bindings compare, and the `expectedVersion` check by line index → red; restore → green.

## 11. Consequences

- One new store dependency (Infisical cloud), one project per tenant, identities per D-29. No second store: Nango is never provisioned unless D-24 says isolate.
- Four new metadata tables and one new reference table in the main DB; three existing tables shrink (§6). The `ENCRYPTION_KEY` path for integration credentials is retired at L3 (Λ2).
- The G2 executor and the G3 refresh worker are the only two components that ever hold plaintext outside Infisical and the provider — the sentence in threat-model §1 becomes checkable by listing them.
