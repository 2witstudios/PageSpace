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

Exactly three executor classes may call `resolve`: the HTTP executor (G2), the relay runner (G4), the browser worker (G6a–c). The refresh worker calls `resolve` for `oauth2` only and is the only caller of `rotate`. The authority's management worker, holding a **`manage`** identity, is the only caller of `rebind` (with an `OwnerConsent` unless the rebind narrows), `revoke` and `describe`. Next.js routes reach the plane only through the ingress handler's `put` and through requests to the management worker (`revoke`, `delete`, `describe`) — never `resolve`, never `rebind`, and never with a `manage` identity of their own (G1c E3). This is enforced by **audience**: every adapter call carries the verified grant (ADR 0004) whose `aud` must match the caller's channel, and `resolve` is unrepresentable for a grant whose `aud` is not narrowed to ONE literal `PresenterChannel` (`NarrowedAudience`, §4.2); `refresh-worker` is a literal audience too, which `ResolvableBy<'refresh-worker'>` limits to `oauth2`. `StoreIdentity.channel` carries the caller's own role at runtime (`PresenterChannel | 'ingress' | 'manage'`): `decideResolve` refuses `identity_refused` when it is not `grant.aud`, and `rebind`, `revoke` and `describe` refuse unless it is `manage` (G1c R8/E3, §2.6).

### 2.2 Operations

| Op | Signature (options object; result unions, never throws for expected outcomes) | Semantics |
|---|---|---|
| `put` | `({ ref: SecretRef; material: SecretMaterial; expectedVersion: CredentialVersion \| null; bindings: PlaneBindings; scope: PlaneScope; consenters: PlaneConsenters; identity: StoreIdentity }) → PutResult` | creates (`expectedVersion: null`) or replaces. **CAS**: refuses with `version_conflict` if the current version ≠ `expectedVersion`. The first put pins `bindings`, `scope` and `consenters` in the plane's bindings row (§2.6); a later put must carry exactly the stored ones. `consenters` must be `owner` for a user-owned account and a non-empty `pinned` set for an agent-page-owned one (`consenters_invalid`). A first put that finds the key already in Infisical adopts it only when it is exactly this put's attempted write, otherwise erases it first (E1, §2.3). Returns the new `CredentialVersion` |
| `resolve` | `<C, K>({ ref; version: CredentialVersion; grant: VerifiedGrant<C>; identity } & NarrowedAudience<C>) → ResolveResult<C, K>` — `C` must be ONE literal channel | returns material **only** if `version` is the current version (or the previous version inside the rotation grace for a grant issued before the rotation, F3) **and** the ref is not revoked **and** the grant's `(tenantId, accountId, credentialVersion)` equal the ref's **and** `identity.channel === grant.aud` (`identity_refused`) **and** the ref is not reconcile-required (`store_unavailable`, E1) **and** `grant.policyVersion` is not below the stored bindings' (`bindings_stale`, H2) **and** `digestBindings(stored bindings) === grant.bindingDigest` **and** `grant.aud` may resolve this `kind` (§4.2). The material is **channel-shaped**: `oauth2` resolves to `OAuth2AccessMaterial` (no `refreshToken`) for every channel but `refresh-worker`. Anything else is one of `version_mismatch \| bindings_stale \| binding_mismatch \| kind_not_resolvable \| identity_refused \| revoked \| not_found \| store_unavailable` |
| `resolveSessionOverHttp` | `({ ref: kind 'session'; version; grant: VerifiedGrant<'http-executor'> & { sessionHttp: true }; identity }) → ResolveResult<'http-executor','session'>` | the ONE audited path by which a `session` kind reaches the HTTP executor; unrepresentable without `grant.sessionHttp: true`, which the authority signs only under the default-off `session_http` permission (ADR 0004 §4.1) |
| `rotate` | `({ ref; expectedVersion; next: SecretMaterial; bindings; identity }) → RotateResult` | `put` with the extra rule that the previous version stays readable for `ROTATION_GRACE_MS`, only to a grant that named it and was issued before the rotation (`iat < rotatedAt`, F3), and is then unreadable; only the refresh worker's identity may call it |
| `rebind` | `({ ref; expectedVersion: PolicyVersion; bindings: PlaneBindings; scope: PlaneScope; consenters: PlaneConsenters; consent: OwnerConsent \| null; identity: StoreIdentity & { channel: 'manage' } }) → RebindResult` | rewrites **only** the plane's bindings row (§2.6; never material, never `secret.version`) — the path every `policyVersion` bump, narrowing and widening takes. **CAS** on the stored `policyVersion` (`version_conflict`); `bindings.policyVersion > expectedVersion`; `tenantId`, `kind` and `ownerRef.kind` unchanged and the owner still derives the stored tenant (`immutable_binding_changed`). An equal-or-narrower `scope` with unchanged owner and consenters needs no consent (R13). Anything else needs `consent` (`consent_required`): an authority-signed step-up consent naming this `ref`, exactly `digestBindings(bindings)` and exactly `consenters`, fresh within `rebindConsentMaxAgeMs`, from a consenter in the **stored** record — the stored user owner, or a member of the stored pinned set (`consent_invalid`) — and consumed single-use by `consentId` through the shared replay store before the write (E2). `identity.channel` must be `manage` (`identity_refused`). Same lock + post-write verify as §2.3 |
| `revoke` | `({ ref; reason: RevokeReason; identity: StoreIdentity & { channel: 'manage' } }) → RevokeResult` (`identity_refused` otherwise) | marks the ref **broker-denied**: every future `resolve` returns `revoked`; **clears `previousVersion` and `rotatedAt`** so no rotation grace survives a revocation (G1a review M7); the material is retained for `REVOKE_RETENTION_MS` so an upstream-revocation attempt can still be made; bumps nothing upstream |
| `delete` | `({ ref; identity; upstream: UpstreamRevocation }) → DeleteResult` | removes the material and all versions. `upstream` records whether an upstream revocation was attempted and its outcome (`'revoked' \| 'unsupported' \| 'failed' \| 'not_attempted'`); the result carries both facts so the UI can say "removed from PageSpace; the key is still valid at the provider" |
| `describe` | `({ ref; identity: StoreIdentity & { channel: 'manage' } }) → DescribeResult` (`identity_refused` otherwise) | version, **`previousVersion`**, kind, `bindings`, `consenters`, timestamps (`rotatedAt`), revocation state — **never material**. `previousVersion`/`rotatedAt` are the plane-attested facts ADR 0004 F5a consumes (M7) |

`SecretRef = { tenantId; accountId; kind }` maps to the Infisical path `/<tenantProject>/<accountId>/<kind>` (one project per tenant, §3). `PlaneBindings = { tenantId; ownerRef; allowedOrigins (canonical); policyVersion; policyDigest; kind }` — the independent binding Codex asked for (threat-model A9). `policyDigest` = SHA3-256 over `canonicalJson(PlaneScope)`, `PlaneScope = { approvalPolicy; resourceRestrictions; boundAgentPageIds (sorted); allowedOrigins (sorted); auxiliaryOrigins (sorted); sessionHttpEnabled; providerSlug }` (§2.4, G1c R1/R7). `StoreIdentity` is the tenant-scoped machine identity handle the executor holds; it is a parameter so a test can pass a wrong-tenant identity and watch `resolve` fail.

### 2.3 Our CAS (Infisical has none on the write side)

```text
lock  = pg_advisory_xact_lock(hash(tenantId, accountId, kind))     -- plane metadata DB, not the app DB
read  = infisical GET secret → { version: v }
check = v == expectedVersion  else version_conflict
write = infisical PATCH/POST secret (material + bindings)
verify= infisical GET secret → { version: v' }; v' == v + 1 and metadata == bindings else write_unverified
commit= plane metadata row { ref, currentVersion: v', previousVersion: v, rotatedAt }
```

The lock serializes writers per secret across replicas; the verify catches an overlapping write that slipped past the lock (a second Infisical writer that is not us). `write_unverified` is a refusal to *report success*, not a rollback — the material may have landed. What happens next is not deferred (G1c E1):

```text
intent = plane metadata row.pendingWrite = { version: v + 1, digest: digestWrite(value, comment), rotation }   -- before write, under the lock
write / verify / commit as above; commit clears pendingWrite
```

A row that still carries `pendingWrite` is **reconcile-required**: the Infisical write may have landed while the metadata commit failed. The next adapter call on that ref — any of put, rotate, resolve, rebind — takes the advisory lock, reads Infisical's current version and write digest, and hands them to `decideReconcile`: `commit_forward` (metadata advances to the pending version, grace opens only for a pending rotation) when they are exactly the pending write, otherwise `fail_closed` — nothing is served or written and the ref stays reconcile-required. `resolve` never serves the ambiguous version: `decideResolve` refuses a reconcile-required ref with `store_unavailable`. `delete` (erasure) is not blocked by it. A **first put** has no row to carry an intent; if its commit failed, the orphaned Infisical key is handled by the next first put: `decideOrphanAdoption` adopts it only when its digest equals this put's attempted-write digest, otherwise the orphan is erased and the put proceeds. The write digest exists only while a write is ambiguous (cleared on commit) and never for a first put, so the plane metadata store holds a hash of material only for that window — a residual stated in the threat model (§4). The pure decision `decideStoreWrite({ expectedVersion, observedBefore, observedAfter })` returns `commit | version_conflict | write_unverified` and is table-tested; the adapter only acts on it.

### 2.4 Bindings are compared at resolve — through the grant's signed digest

The grant carries `bindingDigest = hash(canonicalJson(PlaneBindings))`, computed by the authority over the bindings it evaluated and signed with the grant (ADR 0004 §2.1). `decideResolve` recomputes `digestBindings(stored.bindings)` with the injected hash and compares the two in constant time; **no main-DB fact is consulted at resolve**. A main-DB writer who reassigns `agent_accounts.ownerUserId`, widens `allowedOrigins`, or widens `approvalPolicy`, `resourceRestrictions` or the `agent_account_bindings` set therefore either (a) gets a grant signed over the tampered rows, whose digest differs from the plane's copy → `binding_mismatch`, or (b) cannot get a grant at all. (Codex P1 on PR #2637: the original signature handed `decideResolve` the store's bindings and nothing independently signed to compare against.)

**Amendment 2026-09-16 (G1a review H1, under threat-model A9).** The first `PlaneBindings` bound only `(tenantId, ownerRef, allowedOrigins, policyVersion, kind)`. `policyVersion` is a counter, so a writer who widened the approval policy's scope, trigger or limits, a resource restriction, or the bound-agent-page set — and left the counter alone — kept `bindingDigest` matching. `PlaneBindings` therefore carries `policyDigest = digestPlaneScope(PlaneScope)`, SHA3-256 over the canonical JSON of exactly those four security-relevant fields. Delegation and approval rows are **not** bound here: they are per-use facts, each protected by its own comparison against the signed grant — `DelegationFact` names the account, agent page and delegating human (ADR 0004 F7), `ApprovalFact` names the account, digest, consuming grant and expiry (ADR 0004 F14). Widening therefore requires `rebind` (§2.2) with an `OwnerConsent` from step-up (ADR 0004 §4.1 `grant`), which rewrites the bindings under the owner's authenticated consent.

**Amendment 2026-09-16 (G1a review H2).** The first interface had no way to update `PlaneBindings.policyVersion` when it bumped: `put` needs the full material (the ingress identity is write-only and cannot read it back) and `rotate` is the refresh worker's alone. After any bump, either every grant failed with `binding_mismatch` or the authority signed stale bindings. `rebind` is the missing operation. `policyVersion` stays in the bindings: a non-widening bump (membership change, instruction edit, copy, move) still goes through `rebind`, with the consent of the human whose action caused it, so outstanding grants die at the plane as `binding_mismatch` as well as at the verifier as `policy_epoch`.

### 2.5 Metadata tables — which store holds which (corrected 2026-09-16, G1c R3)

**Main DB** (acceptable because none of it is secret and each row is compared as a fact against the signed grant, never trusted as plane state): `agent_account_grant_nonces` (ADR 0004 §2.4; also the single-use ledger for `OwnerConsent.consentId`, E2), `agent_account_approvals`, `agent_account_delegations`, `agent_account_audit` (ADR 0004 §5 shape).

**Plane metadata store** (its own Postgres, never the app DB; one DDL owner, `store/infisical-dev/plane-metadata.sql`): `agent_account_secret_versions` (`ref`, `currentVersion`, `previousVersion`, `rotatedAt`, `revokedAt`, `revokeReason`, `pendingWrite`) and `agent_account_plane_bindings` (`ref`, `bindings`, `scope`, `consenters`, CAS on `bindings.policyVersion`, §2.6). The first version of this section put `agent_account_secret_versions` in the main DB while M7 called `previousVersion`/`rotatedAt` plane-attested and `StoredSecretFacts.revokedAt` read from those rows: a main-DB writer could un-revoke a credential or reopen grace (`rotatedAt` far in the future). Those facts reach the verifier only through `describe` (`DescribeResult.previousVersion`, `rotatedAt`). The advisory-lock namespace is the plane's, distinct from `advisory-lock.ts`'s existing keys.

### 2.6 Amendment 2026-09-16 (G1c — shape review of #2637/#2638/#2646; point-guard rulings under existing invariants: the main-DB writer is untrusted (H1), fail closed, the custody rule)

- **R1/R7 — scope.** `PlaneScope` gains `sessionHttpEnabled`, `auxiliaryOrigins` and `providerSlug`; each was widenable by a writer who left `policyVersion` alone. The operation registry is keyed by origin as well as provider, and an entry never has a null provider, so a generic-origin account matches no reviewed entry (ADR 0004 §3.4).
- **R2 — who may consent.** `rebind` refuses any `ownerRef.kind` change. The plane pins `PlaneConsenters` at the first put: `owner` (the stored user owner) or a `pinned` set of humans for an agent-page-owned account. Changing that set needs consent from a CURRENT pinned consenter; main-DB drive roles never mint consent authority.
- **R4 — own row.** Bindings live in `agent_account_plane_bindings`, CAS on `policyVersion`; a rebind never touches Infisical, so it never changes `secret.version` or `credentialVersion`.
- **R8/E3 — identity at runtime.** `StoreIdentity.channel` is checked by `decideResolve` (`identity.channel === grant.aud`) and by `decideStoreCaller` for `rebind`/`revoke`/`describe` (`manage`), each with a mutation pair.
- **R13 — consent-free narrowing.** An equal-or-strictly-narrower scope (`isScopeNarrowing`) with owner and consenters unchanged needs no consent: a bump whose causer is not a consenter must still be writable. Any widening needs consent.
- **E1 — reconcile** (§2.3). **E2 — consent binds the ref and is single-use** (`OwnerConsent.ref`, `consentId` consumed through the replay store). **H2 — `bindings_stale`** for a grant whose `policyVersion` is below the stored bindings', distinct from `binding_mismatch`. **R3 + M7** — §2.5.

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

`apps/web` holds **no** store identity, no manage-audience identity (so it can never `rebind`), no root key, no unrestricted signing key, and not the step-up consent key. Its only plane credentials are: the ingress handler's *write-only* identity for `put` (cannot `resolve`), and the authority's grant-signing key held by the authority process. The executors hold reading identities. Verified by a test that the web bundle's env schema (`config/env-validation.ts`) has no `INFISICAL_*_READ*` variable and that `resolve` is not exported from any module `apps/web` imports.

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
| `sessionHttpEnabled` | boolean, default **false** | set only through `manage` (step-up); when true the HTTP executor may resolve this `session` account under the `session_http` permission via `resolveSessionOverHttp`; CHECK false for every kind but `session` |
| `status` | `'active' \| 'revoked' \| 'needs_reauth' \| 'deleted'` | `revoked` = broker-denied; `needs_reauth` = upstream expired/invalid |
| `upstreamRevocation` | `'not_attempted' \| 'revoked' \| 'unsupported' \| 'failed' \| null` | set by `delete` (§2.2) |
| `lastUsedAt`, `createdAt`, `updatedAt`, `revokedAt` | timestamps (UTC) | |

**There is no secret column, no `credentials` jsonb, no `oauthState`, no `baseUrlOverride`.** Every value that is not display metadata is a version or a policy. A test greps the schema file for `credentials`, `secret`, `token`, `password` as *column names* and fails on any hit that is not `kind`.

### 4.2 Per-kind material (store side only; `SecretMaterial = Record<AccountKind, …>` discriminated)

| Kind | Material | Resolvable by (`ResolvableBy<K>`) |
|---|---|---|
| `api_key` | `{ value }` + placement descriptor (header/query name) | `http-executor`, `relay-runner` |
| `bearer` | `{ token; expiresAt \| null }` | `http-executor`, `relay-runner` |
| `oauth2` | `{ accessToken; accessExpiresAt; refreshToken \| null; scopes; issuer; tokenEndpoint }` | `http-executor`, `relay-runner` receive **`OAuth2AccessMaterial`** (the type omits `refreshToken`); only `refresh-worker` receives the full material (`MaterialForChannel`) |
| `session` | `{ format; cookies; storage? }` per S3 §5 | `browser-worker`; `http-executor` **only** through `resolveSessionOverHttp` with `grant.sessionHttp: true` — the default-off `session_http` permission in `permissions/account-permissions.ts` (ADR 0004 §4.1); `ResolvableBy<'http-executor'>` excludes `session` |
| `password` | `{ username; password; totpSecret \| null }` | **`browser-worker` only** (the fill executor, L5c). The type `ResolvableBy<'http-executor'>` excludes `password`; the adapter additionally refuses with `kind_not_resolvable`. Mutation pair required (Control Board §7.4) |

**Amendment 2026-09-16 (G1a review H6).** The guarantees in this table held only for a grant whose `aud` was a literal. `VerifiedGrant.aud` was the whole `PresenterChannel` union, so `resolve` on an unnarrowed grant inferred `C` as the union: `ResolvableBy<C>` admitted `password` and `session` and `MaterialForChannel<C, 'oauth2'>` admitted `refreshToken`, and the call compiled. `VerifiedGrant<A extends PresenterChannel>` is now generic in its audience, and `resolve`'s input is intersected with `NarrowedAudience<C>` — `unknown` for one literal channel, an unsatisfiable `never` property for a union — so an executor must narrow `grant.aud` (a runtime check against its own channel) before it can resolve anything. A type-level test (`store-adapter.types.test.ts`) keeps both directions honest (§10.22).

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

Executors: the credential-bearing part of `integrations/saga/execute-tool.ts:198-230` moves behind the plane in G2 (`applyAuth` is reused as a pure formatter inside the executor; the decrypt location is not reused). The G2 `http_request` executor is **new** and does not inherit `integrations/execution/http-executor.ts` (D-28, threat-model §6.2 Highs).

## 7. Decision D6 — operational posture of the plane (Codex "infrastructure" row)

Executors run as their own processes/Sprites with: no request-body telemetry; core and heap dumps disabled; bounded lifetimes (a browser Sprite is destroyed at grant expiry; an HTTP executor process recycles on a fixed cadence); credential ingress on a dedicated listener excluded from tracing and replay; secret-free logs (the audit record carries names and hashes only). The authority's signing key and the executors' identities are delivered as process secrets, never through the main DB. Onprem: the executor refuses to serve when Infisical reports the enterprise features it depends on as absent (licence lapse, S2 §2.3).

## 8. Fail-closed posture (every line is a RED test)

| # | Situation | Behaviour |
|---|---|---|
| F1 | `resolve` with a grant whose `aud` is not narrowed to one literal channel, or a kind that channel may not resolve | unrepresentable by type (`NarrowedAudience`, `ResolvableBy`); adapter returns `kind_not_resolvable` if reached |
| F2 | `resolve` of kind `password` by any channel but `browser-worker`; `resolve` of kind `session` by `http-executor` (only `resolveSessionOverHttp` with `sessionHttp: true` may) | `kind_not_resolvable` |
| F2a | `oauth2` resolved by any channel but `refresh-worker` | material is `OAuth2AccessMaterial`; `refreshToken` is absent by type and stripped by the adapter |
| F3 | `resolve` with `version ≠ current` (rotation happened) | `version_mismatch`; the previous version is readable only inside `ROTATION_GRACE_MS` (`now < rotatedAt + ROTATION_GRACE_MS`), only by a grant that named it, and only when that grant was issued before the rotation (`grant.iat < rotatedAt`) — the same rule as ADR 0004 F5a, over the same plane-attested `previousVersion`/`rotatedAt`. A revoked ref has no previous version |
| F4 | `digestBindings(stored bindings) ≠ grant.bindingDigest` (owner/tenant/origins/policyVersion/policyDigest/kind) | `binding_mismatch` |
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
| F15 | `rebind` with a consent whose signature fails, whose `bindingsDigest` ≠ `digestBindings(bindings)`, that is older than `rebindConsentMaxAgeMs`, or (user-owned) whose consenting user ≠ the stored `ownerRef` | `consent_invalid`; nothing written |
| F16 | `rebind` with stored `policyVersion` ≠ `expectedVersion`, or `bindings.policyVersion` ≤ it | `version_conflict`; nothing written |
| F17 | `rebind` that changes `tenantId` or `kind` | `immutable_binding_changed` |
| F18 | `rebind`, `revoke` or `describe` by any identity whose `channel` is not `manage` (the web process, an executor, the refresh worker) | not representable by type, and `identity_refused` at runtime (`decideStoreCaller`, G1c E3) |
| F19 | `resolve` whose `identity.channel ≠ grant.aud` | `identity_refused` (G1c R8) |
| F20 | `resolve` of a reconcile-required ref (a pending write whose commit failed) | `store_unavailable`; the ambiguous version is never served; the next locked call reconciles forward or fails closed (G1c E1) |
| F21 | `resolve` with `grant.policyVersion` below the stored bindings' `policyVersion` | `bindings_stale` — distinct from `binding_mismatch` (G1c H2) |
| F22 | `rebind` that changes `ownerRef.kind`, or an owner that no longer derives the stored tenant | `immutable_binding_changed` (G1c R2) |
| F23 | `rebind` that widens the scope or changes consenters with no consent | `consent_required` (G1c R13) |
| F23a | `rebind` with a consent from a user not in the STORED consenter set (a writer who made themselves drive ADMIN), for another ref, or already consumed | `consent_invalid` (G1c R2/E2) |
| F24 | `rebind` to an equal-or-narrower scope with owner and consenters unchanged, no consent | `rebind` (G1c R13) |
| F25 | `put` whose consenters do not match the owner kind (`owner` for user, non-empty `pinned` for agent page), or differ from the pinned set on an existing ref | `consenters_invalid` / `version_conflict` |
| F26 | first `put` over an orphaned Infisical key | adopted only when it is exactly this attempted write; otherwise erased, then written (G1c E1) |

## 9. Pure-function signatures (G1b implements behind `*-adapter.ts` / `*-repository.ts` / `*-worker.ts`)

```ts
// store/store-adapter.ts — the interface (type only; G1b: infisical-store-adapter.ts)
export type StoreAdapter = {
  readonly put: (input: PutInput) => Promise<PutResult>;
  // input.grant is VerifiedGrant<C>; NarrowedAudience<C> makes a union C (an unnarrowed grant) uncompilable (§4.2)
  readonly resolve: <C extends PresenterChannel, K extends ResolvableBy<C>>(input: ResolveInput<C, K> & NarrowedAudience<C>) => Promise<ResolveResult<C, K>>;
  // the ONE path by which `session` reaches the HTTP executor; unrepresentable without grant.sessionHttp: true (§4.1, F2)
  readonly resolveSessionOverHttp: (input: SessionHttpResolveInput) => Promise<ResolveResult<'http-executor', 'session'>>;
  readonly rotate: (input: RotateInput) => Promise<RotateResult>;
  readonly rebind: (input: RebindInput) => Promise<RebindResult>;   // manage audience + OwnerConsent only
  readonly revoke: (input: RevokeInput) => Promise<RevokeResult>;
  readonly delete: (input: DeleteInput) => Promise<DeleteResult>;
  readonly describe: (input: DescribeInput) => Promise<DescribeResult>;
};

// store/decide-store-write.ts (G1b) — the CAS decision
export type DecideStoreWrite = (input: { expectedVersion: CredentialVersion | null;
  observedBefore: CredentialVersion | null; observedAfter: CredentialVersion | null;
  bindingsAfter: PlaneBindings | null; bindingsWritten: PlaneBindings }) =>
  { outcome: 'commit'; version: CredentialVersion } | { outcome: 'version_conflict' } | { outcome: 'write_unverified' };

// store/decide-rebind.ts (G1b) — consent signature + digest + freshness + stored-owner, CAS on policyVersion
export type DecideRebind = (input: { stored: PlaneBindings | null; expectedVersion: PolicyVersion; next: PlaneBindings;
  consent: OwnerConsent; consentPublicKey: Uint8Array; now: number; maxAgeMs: number; verify: Ed25519Verify; hash: HashBytes }) =>
  { outcome: 'rebind' } | { outcome: 'refuse'; reason: 'version_conflict' | 'consent_invalid' | 'immutable_binding_changed' | 'not_found' | … };

// store/digest-plane-scope.ts (G1b) — SHA3-256 over canonicalJson(PlaneScope), id lists sorted
export type DigestPlaneScope = (input: { scope: PlaneScope; hash: HashBytes }) => PolicyDigest;

// store/digest-bindings.ts (G1b) — the same bytes on the authority and the store side
export type DigestBindings = (input: { bindings: PlaneBindings; hash: HashBytes }) => BindingDigest;

// store/decide-resolve.ts (G1b) — every refusal in §8 F1–F5, F10 as data; bindings via the signed digest
export type DecideResolve = (input: { grant: VerifiedGrant; ref: SecretRef; stored: StoredSecretFacts | null;
  now: number; rotationGraceMs: number; hash: HashBytes }) => ResolveDecision;

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
4. Given `decideResolve` with `version` one behind current inside `rotationGraceMs`, `ok` for a grant that named the old version and whose `iat < rotatedAt`; outside it, `version_mismatch`; with `iat ≥ rotatedAt`, `version_mismatch` even inside the window; after `revoke` (previous cleared), `revoked` (G1a review M7).
5. Given stored bindings whose `policyVersion`, `ownerRef` or `allowedOrigins` differ from those the grant's `bindingDigest` was computed over, `binding_mismatch`; `digestBindings` is key-order-independent (canonical JSON) so a reordered-but-equal copy matches.
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
16. Given `resolve` of an `oauth2` ref by `http-executor` or `relay-runner`, the result's material has no `refreshToken` key (type-level: `MaterialForChannel<'http-executor','oauth2'>` lacks it, `// @ts-expect-error` on access; runtime: the adapter strips it before return); by `refresh-worker`, the field is present (PR #2637 P1).
17. Given `resolve` of a `session` ref by `http-executor`, does not compile (`ResolvableBy<'http-executor'>` excludes `session`) and returns `kind_not_resolvable` if reached; given `resolveSessionOverHttp` with a grant whose `sessionHttp` is `false`, does not compile; with `true`, `ok` (PR #2637 P1).
18. Given `decideAccountAccess` with `sessionHttpEnabled: false`, `session_http` is `false` whatever else is true; with `true` and `use: false`, still `false`; with both, `true`.
19. Given the authority issuing a grant, `bindingDigest` equals `digestBindings` over the bindings it read; a grant whose digest was computed over any other bindings fails at the plane, never at the authority (the plane is the independent check).
20. Given stored bindings whose `policyDigest` was computed over an approval policy with a wider `scope.resources`, a `resourceRestrictions` entry with one more repo, or one more bound agent page than the scope the grant's `bindingDigest` covers — with `policyVersion` UNCHANGED — `decideResolve` returns `binding_mismatch`; `digestPlaneScope` is order-independent over `boundAgentPageIds` and `allowedOrigins` (G1a review H1).
21. Given `decideRebind` with a valid consent to exactly the next bindings, `rebind`; with the consent's `bindingsDigest` over any other bindings, a bad signature, `issuedAt` older than `rebindConsentMaxAgeMs`, or (user-owned) a consenting user other than the STORED owner — including the owner a DB writer just wrote — `consent_invalid`; with stored `policyVersion ≠ expectedVersion`, `version_conflict`; with a changed `tenantId` or `kind`, `immutable_binding_changed`. `rebind` is not callable with an identity lacking `audience: 'manage'` (`// @ts-expect-error`), and `apps/web`'s dependency closure holds no manage identity (§3.4). After a successful `rebind` to `policyVersion + 1`, a grant signed under the old bindings is `binding_mismatch` (G1a review H2).
22. Given `resolve` with a `VerifiedGrant` whose `aud` is the unnarrowed `PresenterChannel` union, the call does not compile for `password` or for `oauth2` (`// @ts-expect-error`); with `VerifiedGrant<'browser-worker'>`, `password` compiles; with `VerifiedGrant<'http-executor'>`, `password` does not and `oauth2` material has no `refreshToken`. `tsc` over `store-adapter.types.test.ts` is the assertion; the mutation is removing `NarrowedAudience` from the signature → TS2578 on the unnarrowed lines (G1a review H6).

23. Given `decideResolve` with an identity whose `channel` differs from `grant.aud`, `identity_refused`; mutation: remove the channel compare → red (G1c R8).
24. Given `decideStoreCaller` with an identity whose `channel` is not `manage` for rebind/revoke/describe, `identity_refused`; with another tenant, `not_found`; the adapter's three operations return it against real Infisical; mutation per operation (G1c E3).
25. Given `digestPlaneScope` over two scopes differing only in `sessionHttpEnabled`, one `auxiliaryOrigins` entry, or `providerSlug`, different digests; `auxiliaryOrigins` order-independent (G1c R1/R7).
26. Given `decideRebind` with `ownerRef.kind` changed, `immutable_binding_changed`; with a pinned set `[a]` and a consent from `b` (even with a valid signature), `consent_invalid`; a consent from `a` that changes the set to `[b]`, `rebind`; a consent for another `ref`, `consent_invalid` (G1c R2/E2).
27. Given `isScopeNarrowing` over a table (subset origins/pages, removed restriction value, added restriction key, `sessionHttpEnabled` true→false, policy→null, trigger that asks more, earlier `until`, lower limits → true; each reverse, a changed `providerSlug` or approver → false) and `decideRebind` with a narrowing scope and `consent: null`, `rebind` with `consumeConsentId: null`; a widening with `consent: null`, `consent_required` (G1c R13).
28. Given the adapter rebinding twice with one consent, the second is `consent_invalid` (consumed through the replay store) (G1c E2).
29. Given `decideReconcile` with an observed version and digest equal to the pending write, `commit_forward`; with either different or unobservable, `fail_closed`. Given `decideOrphanAdoption` with equal digests, `adopt`; otherwise `erase`. Against real Infisical: a metadata commit failure then a resolve serves nothing until reconciled; the next put commits forward; a first put whose commit failed is adopted by a retry with the same material and erased by one with different material (G1c E1).
30. Given `decideResolve` with `grant.policyVersion` one below the stored bindings', `bindings_stale`; equal with a different digest, `binding_mismatch` (G1c H2).
31. Given a rebind against real Infisical, the secret's Infisical version and `describe().version` are unchanged (G1c R4); `describe()` returns `previousVersion` after a rotate and null after revoke (G1c R3/M7).

## 11. Consequences

- One new store dependency (Infisical cloud), one project per tenant, identities per D-29. No second store: Nango is never provisioned unless D-24 says isolate.
- Four new metadata tables and one new reference table in the main DB; three existing tables shrink (§6). The `ENCRYPTION_KEY` path for integration credentials is retired at L3 (Λ2).
- The G2 executor and the G3 refresh worker are the only two components that ever hold plaintext outside Infisical and the provider — the sentence in threat-model §1 becomes checkable by listing them.
