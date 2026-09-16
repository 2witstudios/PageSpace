# Spike S2: credential-broker vendor eval — Nango, Infisical (+ Agent Proxy / Agent Vault), agentgateway

> **Date:** 2026-09-14 · **Epic:** Agent Accounts & Credential Broker (`j471yhv7p3abea7mlxrchdu1`) · **Gate:** L0 (S2) · **Feeds:** D-24 (Nango vs the custody rule), Λ4, Λ5, Λ12
> **Type:** Document only. No product code, no sign-ups, nothing provisioned or paid. Public docs and OSS repos only.
> **Method:** every vendor claim is a verbatim quote with its URL, fetched 2026-09-14. Anything not quoted is marked *inference*. Where a doc and the source disagree, the source is cited. Two numbers in the cost section rest on stated assumptions, not on vendor quotes.
> **Superseded context (added 2026-09-16, PR #2633 round 4):** D-21 was revised on 2026-09-15 after this spike. The store is now **self-hosted Infisical OSS on its own Fly app (own Postgres + Redis), with no paid vendor**. D-24 dropped Nango, D-29 chose one identity per tenant, and D-18 made v1 relay-only. The cloud-hosted scorecard cells (§0.1), the cloud cost model (§8.1) and "Onprem (deprioritized)" (§9) record the evidence as it stood on 2026-09-14. They are not the current plan, so the Control Board decision register wins where they differ.
> **Reads:** Control Board §0 liability register, §6 conventions, §7 rules; Codex review `km6yrydf0sc08g6ikoikno7f` ("My store recommendation…"); `infrastructure/docker-compose.tenant.yml`, `env.tenant.template`, `scripts/tenant-stack.sh`, `traefik/tenant-labels.yml`, `UPGRADE.md`; `packages/lib/src/deployment-mode.ts`, `config/env-validation.ts`; `services/fly/flaps-client.ts`; `services/sandbox/{egress,containment,sandbox-env,git-tool-runners}.ts`; `docs/sprites/services-adoption-design.md`.

## 0. TL;DR — the two recommendations

**D-24 (Nango): drop it.** Self-hosted Nango cannot externalize its token store — the only hook is wrapping its single data-encryption key under AWS or GCP KMS, and the tokens themselves stay in Nango's own Postgres (§1.3). It also cannot meet the plane bar's "per-tenant scoped identity for every reader": its API keys are per *environment*, and `GET /connections/{id}` hands the plaintext access token (and, on request, the refresh token) to any holder of that key (§1.4, §1.6). Isolating it costs a second plane's worth of infrastructure (own Postgres, Redis, network, KMS-wrapped key, one Nango environment or instance per tenant) for a free tier that is "Auth and Proxy" only under ELv2, with unsigned images and no key rotation (§1.7–1.10, §8). What Nango uniquely buys — the authorization-code flow and quirks for 1,000+ providers — is not on this epic's critical path: today's integrations are a handful of providers with an OAuth handler already in the repo, and G3 already scopes the refresh lifecycle as "ours otherwise". **Runner-up: isolate Nango as a second plane** on its own Fly custom private network with Managed Postgres, Upstash Redis and a KMS-wrapped DEK (§8.2, ≈ $70/month flat plus an unpublished Enterprise fee if syncs/webhooks are ever wanted). It lost because the reader-scoping gap is structural, not configurable: the boundary between "the web process may proxy" and "the web process may read every tenant's refresh token" would be a *policy on our side*, which is exactly what the custody rule forbids counting.

**Egress broker: Infisical Agent Proxy (the platform feature), not the standalone Agent Vault binary, behind our own authority.** D-22 says "Infisical Agent Vault"; Infisical ships two different things under adjacent names (§3.0), and only the platform Agent Proxy keeps the credential in the Infisical project under the per-project key hierarchy D-17/Λ4 depend on. The standalone Agent Vault is a research-preview MITM proxy with its own SQLite/Postgres store and its own DEK — a *third* credential plane — unless run in Infisical-backed mode, where it still caches "the encrypted snapshot locally" (§3.2). Both are TLS-intercepting forward proxies that need `HTTPS_PROXY` plus a trusted CA inside the agent runtime, and both identify the caller by a bearer the guest holds (§3.3) — the identity shape S1/D-18 says to avoid. Neither does caller-bound grants, a canonical request digest, approval binding or audit-before-execute; those stay ours (§6). agentgateway is a Rust MCP/A2A/LLM data plane, Apache-2.0 under the Linux Foundation, that holds no credentials at rest at all — the brief's "STS with KEK/DEK + KMS" does not exist in its public docs; it exchanges an inbound JWT for a downstream token at an external IdP (RFC 8693/7523) and caches in memory (§4). It overlaps the L4 relay only for MCP-shaped traffic and is not a candidate for L2/L3.

The orchestrator may want a [D-n] on the D-22 wording (Agent Proxy vs Agent Vault); this spike does not decide it, it only shows the two products are not interchangeable.

## 0.1 Scorecard against the custody rule

The plane bar (Control Board intro): own store · own key hierarchy · own network segment · per-tenant scoped identity for every reader · audit before use. Plus the contract's plaintext question: does plaintext ever return to our web process or the sandbox?

| | Nango (self-hosted, free tier) | Infisical store (cloud, D-21) | Infisical Agent Proxy | Agent Vault (standalone) | agentgateway |
|---|---|---|---|---|---|
| Own store | its Postgres; **no external backend** | Infisical's, per-project data keys | in the Infisical project | its own SQLite/Postgres (+ cached snapshot in Infisical-backed mode) | none — not a store |
| Own key hierarchy | one 256-bit DEK, **rotation unsupported**, encryption **optional** | root key → internal KMS root key → per-org/per-project data keys; per-project external KMS (Enterprise) | inherits the project's | own DEK wrapped by an Argon2id KEK from a master password | n/a |
| Own network segment | must be built (Fly custom 6PN) | Infisical cloud (US/EU AWS accounts) | proxy runs where we put it | "different host machine from your AI agents" | where we put it |
| Per-tenant scoped reader identity | **no** — API key = one environment, reads all connections in it | yes — machine identity per project + path conditions (custom roles: Advanced/Enterprise) | one machine identity per proxy instance; scoping = that identity's project role | agent session token per agent context | caller JWT `iss`/`aud`/`sub` + CEL; no stored per-tenant credential to scope |
| Audit before use | free tier: "Auth + proxy only" observability | audit logs Pro+, streaming Enterprise; **not** acceptance-before-execute | request logs; not acceptance-before-execute | request logs, 168h/10k rows default | access logs / OTel; not acceptance-before-execute |
| Plaintext to our web process? | **yes, on demand** via `GET /connections/{id}` (any env key) | yes for whoever holds a reading identity — the executor only, by our design | **no** — swapped at the proxy; agent holds a placeholder | **no** — same; "never returned in an API response" | no — inbound token stripped, exchanged token goes proxy → backend only |
| Plaintext to the sandbox? | only if we call GET and inject | never, by design | no; *vendor default shape:* sandbox holds placeholder + proxy bearer + CA (v1 relay-only: the sandbox holds none of these, D-18) | same | no |
| OAuth authorization-code flow | yes, 1,000+ providers | no (App Connections serve Infisical's own features) | no | no (paste existing tokens; refreshes them) | no |
| OAuth refresh lifecycle | yes: ≥24h cycle, 15-min margin, Redis lock, backoff, exhaustion | no | not found | yes (5-min margin, refresh at proxy time) | no |
| Licence | ELv2 (+ paid Enterprise self-host) | MIT + `ee/` Enterprise licence | part of Infisical (Free tier: static secrets) | MIT + `ee/` | Apache-2.0, LF/AAIF |
| Signed artifacts (Λ12) | **none found** | core image: **none found**; release tags GPG-signed | as core | **cosign keyless** on binaries | **cosign** on images + OpenVEX attest on controller; no SBOM |

## 1. Nango (self-hosted)

### 1.1 Auth types and scoping

> "The authentication mode. Must be one of: "API_KEY", "APP", "APP_STORE", "BASIC", "NONE", "OAUTH1", "OAUTH2", "OAUTH2_CC", "CUSTOM", "TBA", "JWT", "BILL", "TWO_STEP", "SIGNATURE"." — https://nango.dev/docs/reference/api-configuration

> "OAuth 2.0, OAuth 1.0a, API keys, basic auth, custom. 1,000+ APIs supported" — https://nango.dev/docs/guides/auth/auth-guide

Per-user/org/bot scoping is attribution, not authorization:

> "Tags are small key/value strings you attach to a Connect session." … "Their primary purpose is **attribution**." … "Nango uses random UUIDs as connection IDs, so tags are the bridge between a Nango connection and the user, organization, workspace, or other entity in your system." — https://nango.dev/docs/guides/auth/connection-tags-configuration-metadata

> "Each environment in your Nango account is completely isolated with its own: Integration configurations, Functions, Connections, Environment-specific settings." … "Each Nango account comes with dev and prod environments by default," — https://nango.dev/docs/guides/platform/environments

> "Nango has two API key types. They are not interchangeable" … "Environment API keys access a single environment" … "A key without the required scope receives a `403 Forbidden` response." — https://nango.dev/docs/reference/api/authentication

*Inference:* the authorization unit is the environment. A key that can proxy for one connection can read every connection in that environment. There is no per-end-user or per-tenant reader.

### 1.2 Where tokens live, and how they are encrypted

> "Postgres: Stores data for the control plane, API credentials, scheduled tasks, and synced records." — https://nango.dev/docs/guides/platform/self-hosting

> "You must provide your own encryption key via the NANGO_ENCRYPTION_KEY environment variable." … "The encryption key must be a base64-encoded 256-bit key. Key rotation is not supported yet." … "Changing the key after initial setup will cause decryption failures." — https://nango.dev/docs/guides/platform/self-hosting

> "AES-256-GCM with a 256-bit key, a fresh 12-byte initialization vector per encryption, and a 16-byte authentication tag." — https://nango.dev/docs/guides/platform/security

Source of truth for the table and the opt-in nature of encryption (`packages/shared/lib/utils/encryption.manager.ts`):

```ts
public encryptConnection(connection: Omit<DBConnectionDecrypted, 'end_user_id' | 'credentials_iv' | 'credentials_tag'>): Omit<DBConnection, 'end_user_id'> {
    if (!this.shouldEncrypt()) {
        return connection as unknown as DBConnection;
    }
    const [encryptedClientSecret, iv, authTag] = this.encryptSync(JSON.stringify(connection.credentials));
    const storedConnection: Omit<DBConnection, 'end_user_id'> = {
        ...connection,
        credentials: { encrypted_credentials: encryptedClientSecret },
        credentials_iv: iv,
        credentials_tag: authTag
    };
    return storedConnection;
}
```
— https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/lib/utils/encryption.manager.ts (encrypted columns: `_nango_connections.credentials/credentials_iv/credentials_tag`, `_nango_configs.oauth_client_secret`, `_nango_environment_variables.value`, `api_secrets.secret`, `customer_keys.secret`)

> `NANGO_ENCRYPTION_KEY: z.string({ error: 'To learn more about NANGO_ENCRYPTION_KEY, reach out to support.' }).optional(),` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/utils/lib/environment/parse.ts

*Inference:* with no `NANGO_ENCRYPTION_KEY` the credentials column holds plaintext JSON. Encryption at rest is an operator choice, not a property of the product, and the one key cannot be rotated.

### 1.3 Can the token store be externalized? — No (D-24, part 1)

Searched: nango.dev docs, changelog, README, GitHub issues/discussions, source tree. A pluggable secret backend for connection credentials (Vault, Infisical, KMS-as-store, external secret manager): **NOT FOUND**. What exists is envelope-wrapping the one DEK:

```ts
export interface DekEnvs {
    NANGO_ENCRYPTION_KEY?: string | undefined;
    NANGO_ENCRYPTION_KEY_WRAPPED?: string | undefined;
    NANGO_KMS_KEY_ARN?: string | undefined;
    NANGO_GCP_KMS_KEY_NAME?: string | undefined;
}
```
> "KMS unwrap when NANGO_ENCRYPTION_KEY_WRAPPED is set, passthrough for NANGO_ENCRYPTION_KEY" … `throw new Error('NANGO_ENCRYPTION_KEY and NANGO_ENCRYPTION_KEY_WRAPPED are mutually exclusive: set only one');` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/kms/lib/registry.ts

> `export const dek = await DekRegistry.create(envs);` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/lib/env.ts

> "DekRegistry.create(envs) runs an (in Nango cloud) AWS KMS decrypt network call at module-import time" — review comment on PR #7463 (merged 2026-09-14), https://github.com/NangoHQ/nango/pull/7463

Docs for `NANGO_KMS_KEY_ARN` / `NANGO_GCP_KMS_KEY_NAME`: NOT FOUND on nango.dev (source-only, landed this month).

*Inference:* the DEK is unwrapped into process memory at boot and the ciphertext stays in Nango's Postgres. That is key custody moved to AWS/GCP KMS, not token custody moved out of Nango. Under the custody rule Nango remains a credential plane no matter how the DEK is sourced. Also: PageSpace runs on Fly, which has no KMS; the wrapped-DEK path requires an AWS or GCP account and outbound reach to it at boot.

### 1.4 Does the agent (or our web process) ever receive the token?

Both paths exist, and the direct one is the default API surface.

Proxy (token stays inside Nango):
> "Use the requests proxy to make authenticated API requests to the external API." — https://nango.dev/docs/guides/platform/proxy-requests
> `"/proxy/{anyPath}"` … Connection-Id: "The connection ID used to create the connection." … "The response from the external API is passed back to you exactly as Nango gets it" — https://nango.dev/docs/reference/api/proxy/get

Direct (token returned to the caller):
> `GET /connections/{connectionId}` … force_refresh: "If true, Nango will attempt to refresh the access access token regardless of its expiration status (false by default)." … refresh_token: "If true, return the refresh token as part of the response (false by default)." — https://nango.dev/docs/reference/api/connections/get (response `credentials` fields: `access_token`, `refresh_token`, `expires_at`, `raw`)
> Node SDK `getConnection`: "Returns a specific connection with credentials." … refreshToken: "If `false`, the refresh token is not included in the response, otherwise it is. In production, it is not advised to return the refresh token, for security reasons, since only the access token is needed to sign requests." — https://nango.dev/docs/reference/backend/backend-sdk/node
> `refresh_token: z.stringbool().optional().default(false), force_refresh: z.stringbool().optional().default(false),` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/server/lib/controllers/connection/connectionId/getConnection.ts

**Answer (requirement 1):** plaintext *can* return to our web process on demand, to any holder of the environment API key, with no per-connection or per-caller gate. It never reaches the sandbox unless we forward it. Whether it returns is a property of *our* code, not of Nango — which is the custody rule's point: the boundary must be the plane's, not the caller's discipline.

### 1.5 Refresh lifecycle

> "Nango automatically refreshes OAuth access tokens before they expire." … "Nango refreshes each access token at least once every 24 hours." … "Nango automatically retries failed refreshes on its periodic cycle." … "Nango can notify your app via webhook so you can prompt the user to reconnect." — https://nango.dev/docs/guides/auth/token-refreshing

> "Redis: Caches system data, including socket information, token refresh locks, and rate limits." — https://nango.dev/docs/guides/platform/self-hosting

```ts
const lockKey = `lock:refresh:${environment_id}:${providerConfigKey}:${connectionId}`;
lock = await locking.tryAcquire(lockKey, ttlInMs, acquisitionTimeoutMs);   // ttlInMs = 10000
if (props.connection.refresh_exhausted) { return Err(new NangoError('connection_refresh_exhausted')); }
```
— https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/lib/services/connections/credentials/refresh.ts
> `REFRESH_FAILURE_COOLDOWN_MS = ms('30seconds'); REFRESH_MARGIN_MS = ms('15minutes'); MAX_CONSECUTIVE_DAYS_FAILED_REFRESH = 4;` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/shared/lib/services/connections/utils.ts
> `if (config?.url) { … return new RedisKVStore(…) } return new InMemoryKVStore();` — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/kvstore/lib/index.ts

Rotation: a general refresh-token-rotation statement was NOT FOUND in docs; one open bug: "github-app-oauth: refresh_token rotation breaks on 2nd refresh — connection_config.userCredentials never updated" — https://github.com/nangohq/nango/issues/6136

*Inference:* the lifecycle is real and reasonable (lock per connection, backoff, exhaustion, 24h floor), but the lock is Redis-backed only when `NANGO_REDIS_URL` is set — a multi-replica self-host without Redis serializes nothing. Webhooks (the reconnect signal) are Enterprise-only on self-host (§1.7). This is the part we would be buying; §7 weighs it against building it.

### 1.6 Per-tenant reader identity — the structural gap (D-24, part 2)

The plane bar requires "a per-tenant scoped identity for every reader". Nango's reader identity is the environment API key (§1.1), and every key can call §1.4's direct endpoint. To get one reader per tenant we would need one Nango *environment* per tenant (accounts ship with two; RBAC on self-host is Enterprise-only, §1.7) or one Nango *instance* per tenant (§8.2 multiplies). Neither is a configuration of the free self-host; both are a different deployment.

### 1.7 Self-hosting: what the free tier is

> "A limited free self-hosting option is available for hobby projects." … "It is intended for lightweight deployments that need Auth and Proxy." … "Without the managed features and support included with Enterprise self-hosting." … "An Enterprise plan subscription is required." — https://nango.dev/docs/guides/platform/self-hosting

Feature table (Free / Enterprise), same page: API Auth yes/yes · Proxy yes/yes · Observability "Auth + proxy only"/"Full" · OpenTelemetry export no/yes · Syncs no/yes · Webhooks no/yes · MCP server no/yes · RBAC no/yes · MFA no/yes · SAML SSO no/"Nango Cloud only".

> "Recommended configuration: 5 Node services: 1 CPU, 2GB RAM per service; Postgres: 2 CPU, 8GB RAM, 128GB storage." … "By default, Nango is deployed using Helm charts." … "If you deploy with Docker Compose, the bundled database uses local container storage." — same URL

Compose reference: `nangohq/nango-server:hosted` (linux/amd64), `postgres:16.0-alpine`, `redis:7.2.4`, elasticsearch `8.13.0` "# Optional dependency" — https://raw.githubusercontent.com/NangoHQ/nango/master/docker-compose.yaml

Open question upstream, unanswered: "clarify self-hosted feature set" — https://github.com/NangoHQ/nango/issues/5536 (opened 2026-02-27, Stale)

### 1.8 Offline behaviour

> "Self-hosted instances do not automatically send telemetry back to Nango." — https://nango.dev/docs/guides/platform/self-hosting

But the hosted Connect UI is hard-wired to Nango's cloud API, and the report was closed as not planned:
> "When self-hosting, the Connect UI connects to https://api.nango.dev instead of the configured backend" — https://github.com/NangoHQ/nango/issues/5432

No licence-key env var was found in the env schema (it defines `NANGO_ENTERPRISE` and `NANGO_CLOUD` flags) — https://raw.githubusercontent.com/NangoHQ/nango/master/packages/utils/lib/environment/parse.ts. ELv2 forbids circumventing "license key functionality" (§1.9). KMS-wrapped-DEK mode needs KMS reachability at boot (§1.3).

### 1.9 Licence

> "Elastic License 2.0 (ELv2)" … "You may not provide the software to third parties as a hosted or managed service, where the service provides users with access to any substantial set of the features or functionality of the software." … "You may not move, change, disable, or circumvent the license key functionality in the software" — https://raw.githubusercontent.com/NangoHQ/nango/master/LICENSE

> "Enterprise Self-Hosted pricing contain a fixed annual license and maintenance fee." — https://nango.dev/docs/guides/platform/self-hosting (number: NOT FOUND)

*Inference:* running Nango inside PageSpace's own product, as internal plumbing, is not "providing the software to third parties as a hosted service"; exposing Nango's dashboard or Connect UI to tenants would be closer to the line. Legal should read it if the runner-up is ever chosen.

### 1.10 Version, cadence, provenance (Λ12)

Releases: v0.71.7 (2026-09-11), v0.71.6 (09-02), v0.71.5 (08-27), v0.71.4 (08-10), v0.71.3 (08-03), v0.71.2 (07-21), v0.70.7 (06-16) … — https://github.com/NangoHQ/nango/releases. *Inference:* a patch every one to two weeks. v0.71.7 notes include "_(dockerfile)_ Fix vulns in image (#7351)", "_(docker)_ Remove npm from docker images (#7381)" — https://github.com/NangoHQ/nango/releases/tag/v0.71.7

Image: Docker Hub `nangohq/nango-server`, tags `hosted`, `hosted-0.71.7`, `hosted-<sha>`; built from `Dockerfile.self_hosted` whose base is `FROM nangohq/nango:${BASE_IMAGE_HASH}` — https://hub.docker.com/r/nangohq/nango-server, https://raw.githubusercontent.com/NangoHQ/nango/master/Dockerfile.self_hosted. Signing, SBOM, provenance attestation: **NOT FOUND** in the build script or CI workflow.

Pin if ever used: `nangohq/nango-server:hosted-0.71.7` by digest.

Security posture: "Nango is SOC 2 Type II certified, GDPR compliant, and HIPAA compliant." … "Self-hosted deployments run on infrastructure you control, and all retention periods are configurable when self-hosting." — https://nango.dev/docs/guides/platform/security

### 1.11 Pricing

https://www.nango.dev/pricing: Free "$0 /mo", 10 connections, "Hard-capped limits, reset monthly". Pay-as-you-go "$50 /mo" with "$50 in credits, each month", "$0.29 / connection", "$0.72 / hour" compute, "$0.5 / GB". Enterprise "Custom pricing", connections "can be as low as $0.01/connection/month at scale". Self-hosted Enterprise: fixed annual fee, unpublished.

## 2. Infisical (the store, D-21)

### 2.1 Key hierarchy — maps to tenant domains (Λ4)

> "All symmetric encryption operations in Infisical, with the exception of those proxied through External KMS and HSM systems, use a software-backed 256-bit Advanced Encryption Standard (AES) cipher in Galois Counter Mode (GCM) with 96-bit nonces, **AES-256-GCM**." — https://infisical.com/docs/internals/security

> "The root encryption key is a 256-bit AES key provided by the operator as an environment variable." … "never leaves the server's memory during operation." … "The root encryption key can alternatively be sourced from an external Hardware Security Module (HSM) such as Thales Luna HSM or AWS CloudHSM." — same

*Format by deployment mode* (docs/self-hosting/configuration/envars): the standard image (`infisical/infisical`, the `v0.165.10` pin in §9/§10) takes `ENCRYPTION_KEY` as a **16-byte hex string** (`openssl rand -hex 16`); only FIPS-enabled deployments (`infisical/infisical-fips`) take a **256-bit base64** key (`openssl rand -base64 32`). The 256-bit statement above is the security-internals description; the env-var contract for our non-FIPS pin is the 16-byte hex form, and §9's template uses that.

> "The Internal KMS Root Key is automatically generated when an Infisical instance starts for the first time." … "encrypts all organization and project data keys" … "encrypted at rest using the Root Encryption Key and stored in the database." — same

> "Each organization and each project has its own dedicated data key, providing cryptographic isolation between tenants." — same

> "Project data keys can optionally be managed by an external KMS instead of the Internal KMS Root Key, allowing organizations to maintain control over their encryption keys." — same (AWS KMS, AWS CloudHSM, GCP KMS)

> "Infisical supports the use of external KMS solutions to enhance security and compliance." — https://infisical.com/docs/documentation/platform/kms-configuration/overview (per-project KMS is chosen at project creation or under the project's Settings → Encryption)

> AWS KMS: "Go to **Settings**, select **Encryption**, then select **Add KMS**" … "all encryption and decryption operations will be handled by the chosen KMS" — https://infisical.com/docs/documentation/platform/kms-configuration/aws-kms

**Verified for Λ4:** one Infisical project per PageSpace tenant domain gives each tenant its own data key by construction; external per-project KMS is available but Enterprise-tier (§2.6). On Pro/Advanced every project key sits under the shared Internal KMS Root Key. The tenant domain itself must be defined by G1a (Codex: "a drive is not automatically a tenant"; user-owned global accounts sit outside any drive).

### 2.2 Machine identities — per-tenant readers

Auth methods: Token, Universal (Client ID + Client Secret), Kubernetes, AWS, Azure, GCP, OIDC ("A platform-agnostic, JWT-based authentication method for workloads using an OpenID Connect identity provider."), SPIFFE, LDAP — https://infisical.com/docs/documentation/platform/identities/machine-identities

> "Machine identities are **permission-based, not machine-based**" … "Each distinct combination of project access + environment access + secret paths = 1 identity" … "If multiple machines require identical permissions to the same secrets, they share a single machine identity" … isolation boundaries: "Prevents one compromised app from accessing another app's secrets" — https://infisical.com/docs/documentation/platform/identities/overview

> Universal Auth: Client Secret TTL and "The maximum number of times that the Client Secret can be used together with the Client ID to get back an access token"; access token lifetime (default 30 days), max lifetime, max uses; Trusted IPs "The IPs or CIDR ranges that the Client Secret can be used from together with the Client ID" (paid tier) — https://infisical.com/docs/documentation/platform/identities/universal-auth

> Permission conditions: `"conditions": { "environment": { "$eq": "production" } }` and `"conditions": { "secretPath": { "$glob": "/app/config/**" } }`; "`*` doesn't cross `/` path boundaries—use `**` for multi-segment matching." — https://infisical.com/docs/internals/permissions/project-permissions

> Custom roles restrict "access to specific secrets, folders, and environments". "Custom roles require the Enterprise plan; built-in roles are available on all plans." — https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls (the pricing page lists "custom roles" at Advanced — the two sources disagree; verify with sales before G1b binds to a tier)

> Temporary privileges: "Set a limited duration for temporary access grants." "Duration — How long the privilege remains active. Defaults to **Permanent**." — https://infisical.com/docs/documentation/platform/access-controls/additional-privileges

**Verified for Λ4:** one identity per tenant project, restricted by project role (+ path/environment conditions), satisfies "no identity can read every tenant". Each such identity is billed (§2.6): this is the dominant cost line in §8.1. OIDC auth would let the executor present a short-lived, audience-bound JWT instead of a long-lived Client Secret — worth pairing with G1b's signed grants.

### 2.3 Self-host container and cloud parity; offline licence (protections must not silently lapse)

> "Run Infisical on your own infrastructure, from a single container to a high availability cluster" … "Infisical runs on air-gapped bare metal, Kubernetes clusters, and cloud VMs alike" — https://infisical.com/docs/self-hosting/overview

> Docker Compose: three services (backend, PostgreSQL, Redis); required env `ENCRYPTION_KEY`, `AUTH_SECRET`; `chmod 600 .env`; `docker compose -f docker-compose.prod.yml up -d` — https://infisical.com/docs/self-hosting/deployment-options/docker-compose
> `image: infisical/infisical:latest # PIN THIS TO A SPECIFIC TAG` ; `image: postgres:14-alpine` ; `image: redis` — https://raw.githubusercontent.com/Infisical/infisical/main/docker-compose.prod.yml

> "most features in Infisical are free to use, others are paid and require purchasing an enterprise license." … "Assign the issued license key to the `LICENSE_KEY` environment variable in your Infisical instance." … "Your Infisical instance will need to communicate with the Infisical license server to validate the license key." … offline: "Assign the issued offline license key to the `LICENSE_KEY` environment variable in your Infisical instance." — https://infisical.com/docs/self-hosting/ee

> "when the license expires, Infisical will continue to run, but EE features will be disabled until the license is renewed or a new one is purchased." — https://infisical.com/docs/self-hosting/ee

What the source does (`backend/src/ee/services/license/license-service.ts`):

```ts
if (contents.license.terminatesAt) {
  const terminationDate = new Date(contents.license.terminatesAt);
  if (terminationDate < new Date()) { isValidOfflineLicense = false; logger.warn(`Infisical EE offline license has expired`); }
}
```
```ts
const syncSelfHostedFeatures = async (shouldThrow: boolean = false) => {
  …
  } catch (error) {
    logger.error(error, "Failed to sync self-hosted license features from License Server v2");
    if (shouldThrow) throw error;
  }
};
const job = new CronJob("*/10 * * * *", () => syncSelfHostedFeatures());
```
— https://raw.githubusercontent.com/Infisical/infisical/main/backend/src/ee/services/license/license-service.ts

**Offline-licence behaviour, verified from source (requirement 5):**
- An offline key's `terminatesAt` is checked at process start only. Expired at boot → the OSS default feature set (EE off). Expiring while running → EE stays on until the next restart. No grace constant, no re-check timer in this file.
- An online key re-syncs every 10 minutes; if the licence server is unreachable the catch logs and *keeps the last entitlements*. If the server returns reduced entitlements, features drop at the next sync.
- "Protections cannot silently lapse" cuts the other way here: the EE features we would rely on (audit logs, audit-log streaming, external KMS) switch **off** on expiry — the store keeps serving secrets with fewer controls. For onprem the gate is ours: the executor must refuse to serve when the store reports the enterprise features it depends on are absent, and alert. (Onprem is deprioritized per D-21; recorded so it is not rediscovered.)
- Encryption itself is not licence-gated: the root key → data key hierarchy is core MIT.

Licence text:
> "All content that resides under any "ee/" directory of this repository, if such directories exists, are licensed under the license defined in "ee/LICENSE"." … "Content outside of the above mentioned directories or restrictions above is available under the "MIT Expat" license" — https://github.com/Infisical/infisical/blob/main/LICENSE
> "This software and associated documentation files (the "Software") may only be used in production, if you (and any entity that you represent) have agreed to, and are in compliance with, the Infisical Subscription Terms of Service" — https://github.com/Infisical/infisical/blob/main/backend/src/ee/LICENSE.md
> Self-hosted ToS: "any other deployment model requires an Order Form or separate written agreement expressly providing for it." — https://infisical.com/terms/self-hosted

### 2.4 Secrets API: resolve, version, CAS, rotation, TTL

> `GET /api/v4/secrets/{secretName}` (projectId, environment, secretPath, `version`, `expandSecretReferences`) → `secret.version`, `secret.id`, `secret.secretValue` — https://infisical.com/docs/api-reference/endpoints/secrets/read
> `PATCH /api/v4/secrets/{secretName}`: "No version or conditional parameter exists (no ifMatch, expectedVersion, or similar conditional headers)." — https://infisical.com/docs/api-reference/endpoints/secrets/update (same for the v3 raw endpoint)
> "Every time a secret change is performed, a new version of the same secret is created." — https://infisical.com/docs/documentation/platform/secret-versioning
> Rotation: dual-phase Active / Inactive / Revoked; "The one user you can't name is the one your app connection authenticates with" — https://infisical.com/docs/documentation/platform/secret-rotation/overview (built-in rotations are for databases/cloud creds, not arbitrary OAuth providers)
> Dynamic secrets: "generated on-demand upon access" … "unique to every identity using them" … "available under Infisical's Advanced plan." — https://infisical.com/docs/documentation/platform/dynamic-secrets/overview

**Consequence for G1b/G3 (store adapter "versioned CAS"):** Infisical has read-side versions but no write-side compare-and-swap. The OAuth refresh worker must serialize on *our* side (a Postgres advisory lock or row lock in the plane's own metadata, keyed by account + credential version), read `secret.version` before refreshing, and treat a version mismatch after the write as a lost race to reconcile — Infisical will not refuse the overlapping write for us. Same shape as the Nango `lock:refresh:` key (§1.5), built once, tested first (§7 rules).

### 2.5 Audit

> "Note that Audit Logs is a paid feature. If you're using Infisical Cloud, then it is available under the **Pro**, and **Enterprise Tier** with varying retention periods." … fields "event", "actor", "orgId", "projectId", "ipAddress", "userAgent", "userAgentType", "timestamp" — https://infisical.com/docs/documentation/platform/audit-logs
> "Infisical Audit Log Streaming enables you to transmit your organization's audit logs to external logging providers" … "available under the **Enterprise Tier**" — https://infisical.com/docs/documentation/platform/audit-log-streams/audit-log-streams

*Inference:* Infisical's audit is after-the-fact and tier-gated. "Durable audit acceptance before privileged execution" (Codex #12, Control Board audit shape) is not something any store provides; it is our executor's first step, written to our Admin Postgres trust plane before the resolve call.

### 2.6 Pricing and limits

https://infisical.com/pricing (Secrets Management):
- Free "$0 forever" — "5 identities, unlimited projects, 3 environments, 10 secret syncs, Agent Proxy for static secrets"
- Pro "$20/identity/month annual, $23 monthly" — "Unlimited identities, 6 environments/project, SAML SSO, secret versioning, point-in-time recovery, rotation for public databases, honey tokens, IP allowlisting, 30-day audit retention"
- Advanced "$40/identity/month annual, $46 monthly" — "Everything in Pro, plus dynamic secrets, gateways, full secret rotation, custom roles, temporary access, SSO/MFA enforcement, 90-day audit retention"
- Enterprise "Custom, billed annually" — "Everything in Advanced, plus LDAP, SCIM, user groups, approval workflows, KMIP, external KMS and HSM, audit log streaming, sub-organizations, 99.99% SLA"
- "An identity is any principal that authenticates to Infisical, human or machine."

Per-secret caps: NOT FOUND on the pricing page. Per-API-call pricing: NOT FOUND. OSS default rate limits in `license-fns.ts` (fetcher paraphrase): `readLimit: 60, writeLimit: 200, secretsLimit: 40`.

### 2.7 Version, cadence, provenance (Λ12)

Releases v0.165.10 (2026-09-11) … v0.165.3 (09-03): eight patch tags in nine days; tags "signed with GitHub's verified signature", key `B5690EEEBB952194` — https://github.com/Infisical/infisical/releases
Release workflow pushes `infisical/infisical` and `infisical/infisical-fips` (Docker Hub) and `public.ecr.aws/p5f0g7h8/infisical`, `linux/amd64,linux/arm64`, Snyk scan `continue-on-error: true`; cosign / SBOM / provenance attestation steps: **NOT FOUND** — https://raw.githubusercontent.com/Infisical/infisical/main/.github/workflows/release-standalone-docker-img-postgres-offical.yml
Cloud regions: "Dedicated US AWS account" and "Dedicated EU AWS account" … "Each region operates in a separate AWS account" — https://infisical.com/docs/internals/architecture/cloud
Posture: "Infisical holds **SOC 2 Type II**, **HIPAA**, and **GDPR** certifications." … "most recently a full-coverage gray box test by Cure53" — https://infisical.com/ ; DPA text: NOT FOUND (`/dpa` 404; trust portal JS-gated).

Pin for onprem: `infisical/infisical:v0.165.10` by digest (cloud is unpinnable — Λ4's "trusted custodian" includes trusting their rollout).

## 3. Infisical's egress brokers: Agent Proxy vs Agent Vault (D-22's "Agent Vault")

### 3.0 Two products, one name in D-22

| | **Agent Proxy** (platform feature) | **Agent Vault** (standalone OSS) |
|---|---|---|
| Docs | infisical.com/docs/documentation/platform/agent-proxy/ | docs.agent-vault.dev, github.com/Infisical/agent-vault |
| Credential store | the Infisical project (per-project key, machine identity, audit) | own SQLite/Postgres + own DEK; optional Infisical-backed mode with a local cached snapshot |
| Status | in the product; Free tier "Agent Proxy for static secrets" | "research preview" (April 2026); "API is subject to change" |
| OAuth refresh | NOT FOUND | yes (paste tokens; 5-min margin) |
| Caller identity | machine identity on the proxy (`start`) **and** on the agent side (`connect --client-id/--client-secret`) | agent session token in the CONNECT handshake |
| Artifact signing | as core image (none found) | cosign keyless on release binaries |

### 3.1 Agent Proxy (platform)

> "The **Infisical Agent Proxy** is a credential broker for AI agents and untrusted code execution environments." … "swaps dummy credentials for real ones (or replaces auth headers entirely), before forwarding the request to the target service." — https://infisical.com/docs/documentation/platform/agent-proxy/overview

Placeholder substitution mechanics:
> "A proxied service tells the agent proxy how to apply credentials to traffic bound for an external service." … header rewrite: "The agent doesn't need to send any credential; if it sends a made-up one, the header is overwritten with the real value." … secret substitution: "The agent is handed a dummy placeholder value. The agent proxy swaps it for the real credential wherever it appears in the request." … host pattern `host[:port][/path]`; dynamic secrets: "The first request that needs the credential mints a lease; each agent session gets its own, and later requests reuse it." — https://infisical.com/docs/documentation/platform/agent-proxy/proxied-services
> "When your agent connects, it gets an environment variable `GITHUB_TOKEN` (the placeholder name the GitHub template uses) set to the fake `ghp_…` placeholder." — https://infisical.com/docs/documentation/platform/agent-proxy/quickstart/credentials

What it does with TLS:
> "Root CA (in Infisical, per org)" — "its private key never leaves the server"; "Intermediate CA (in Agent Proxy memory)" — "short-lived intermediate certificate (7 days, re-signed automatically before expiry)"; "Leaf certificates (one per hostname)" — "valid 24 hours, cached in memory". The connect wrapper "downloads the root CA to `~/.infisical/agent-proxy/mitm-ca.pem`" and points "standard trust environment variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT`) at it." … "sets `HTTPS_PROXY` and `HTTP_PROXY` point at the Agent Proxy. `NO_PROXY` always includes `localhost,127.0.0.1`." … "the agent has no access at all to the process holding the real credentials." … "Run multiple Agent Proxy instances with the same machine identity behind a TCP load balancer." — https://infisical.com/docs/documentation/platform/agent-proxy/standalone-agent-proxy

**Answer (requirement 1):** plaintext never returns to the sandbox. In the vendor's default shape the sandbox holds a placeholder, the proxy address, a CA and a `connect` bearer (§3.3). In v1 relay-only (D-18) the sandbox holds none of these, because only the server-side runner calls the proxy. It never returns to our web process either — the proxy process resolves it, under a machine identity that is *the proxy's*, not the web app's.

### 3.2 Agent Vault (standalone)

> "A credential broker for AI agents to prevent credential exfiltration." — https://docs.agent-vault.dev/
> "Instead of giving AI agents credentals directly, you store them in Agent Vault and force your agents to route HTTP requests through it." … "Agent Vault is in active development and the API is subject to change." … "Deploy Agent Vault as a separate service on a different host machine from your AI agents." … "By default Agent Vault stores all state in a local SQLite database." … "For production deployments, set the DATABASE_URL environment variable to a PostgreSQL connection string." — https://github.com/Infisical/agent-vault/blob/main/README.md
> "Agent Vault is a TLS-intercepting, credential-injecting forward proxy purpose-built for agent workloads." — https://www.prweb.com/releases/infisical-launches-agent-vault-letting-engineering-teams-ship-ai-agents-to-production-without-exposing-credentials-302749986.html
> `export HTTPS_PROXY="http://${AGENT_VAULT_TOKEN}:my-vault@127.0.0.1:14322"` … `agent-vault ca fetch -o /etc/ssl/certs/agent-vault-ca.pem` … "Leave the upstream `Authorization` header blank or set it to a placeholder — Agent Vault strips whatever the client sends and attaches the real credential at the proxy boundary." — https://docs.agent-vault.dev/guides/connect-custom-agent

Its own key hierarchy (a third plane):
> "A random 256-bit **DEK** (Data Encryption Key) is generated on first boot. This key encrypts all credentials and the CA private key." … "Argon2id derives a **KEK** (Key Encryption Key) that wraps the DEK. The KEK is never stored — it is derived in memory, used to unwrap the DEK, then wiped." … "No credential value stored in the vault is ever returned in an API response or written to a log." — https://docs.agent-vault.dev/learn/security

Infisical-backed mode:
> "Credentials live in an Infisical instance. Agent Vault polls Infisical at a per-vault cadence, caches the encrypted snapshot locally, and serves it to proxied requests." … "Local mutations are rejected; Infisical is the source of truth" … on sync failure "keeps serving the last good snapshot" — https://docs.agent-vault.dev/learn/credential-stores

OAuth refresh:
> OAuth credentials "store access and refresh tokens with automatic token refresh." … "the access token nears expiry (within 5 minutes), the proxy automatically refreshes it before injecting." … agents with the proxy role "cannot read credential values — they are only injected at proxy time" — https://docs.agent-vault.dev/learn/credentials

*Inference:* Agent Vault does not run an authorization-code flow; a human pastes tokens. In Infisical-backed mode the local cached snapshot is credential ciphertext at rest under Agent Vault's DEK, which makes it a plane in its own right by the custody rule. Version v0.39.3 (2026-09-01), binaries cosign-verified against `refs/tags/` and the GitHub Actions OIDC issuer — https://github.com/Infisical/agent-vault/releases

### 3.3 What both brokers assume about the sandbox — and what Sprites give us

Both need three things inside the agent runtime: `HTTPS_PROXY` set, the MITM CA trusted, and a bearer (Agent Proxy: the `connect` command takes `--client-id` / `--client-secret` or `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` / `_SECRET` on the *agent* side, plus `--projectId`, `--env`, `--path` — https://infisical.com/docs/documentation/platform/agent-proxy/standalone-agent-proxy; Agent Vault: `AGENT_VAULT_TOKEN` in the proxy URL, "authenticates requests via a session token during the CONNECT handshake so that every request is scoped to a specific agent context" — https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents).

Against a hostile guest (Λ6), the env vars are advisory: root in the Sprite unsets `HTTPS_PROXY` and dials the provider directly. The only in-guest-bypass-proof control would be the Sprite egress policy (`packages/lib/src/services/sandbox/egress.ts`). That policy is a **DNS-name allowlist, not an L3 boundary**: "Sprites egress policy is DNS-name-only and cannot match IP-literal/6PN egress", and today "Both agent sandboxes and human terminals run **full (open) egress**" (`packages/lib/src/services/sandbox/FULL-EGRESS-ENABLEMENT.md`). Forcing a sandbox through a proxy therefore needs a policy change that has not been made, plus the platform continuing to block direct dials: the allowlist would have to name **only** the proxy host — "Raw IP connections are blocked unless the IP was resolved from an allowed domain." and "Private IPs are always blocked, so a Sprite can't reach into private network ranges," (quoted in `egress.ts` from docs.sprites.dev/concepts/networking). Two consequences for L4, recorded here so G4 does not rediscover them:
1. *Only for the G4-deferred sandbox-originated path:* the proxy must be reachable by a public DNS name (Sprites block private ranges), so its front door is public and its authentication is load-bearing. Under v1 relay-only (D-18) only the server-side runner calls the proxy, which can stay on a private network.
2. Both brokers put a guest-held bearer in the sandbox — Agent Vault's session token, Agent Proxy's Universal Auth client secret on the `connect` side — the shape S1/D-18 exists to replace. A machine-identity secret inside a hostile guest is extractable and is a standing Infisical credential, so if Agent Proxy is used, `connect`'s identity must be a per-sandbox, per-generation identity with a max-uses/TTL-bounded client secret (§2.2 Universal Auth knobs) minted by our provisioner, or our authority must sit in front of the proxy and the sandbox must never hold one. Either way the broker does not solve the identity problem; S1's answer does. **v1 (D-18, answered): relay-only** — the server-side tool runner originates every credentialed operation and is the only `connect`-side caller; the sandbox holds no bearer, no Universal Auth secret and no presenter key. The relay-side runner still needs its own `connect` identity. It is unspecified in this spike, and G2 must close it (§9, "Relay-side `connect` identity"). How a *sandbox-originated* request would authenticate to the proxy (the per-generation identity above, or the server-opened bound duplex channel from S1 §3.4 / ADR 0006 amendment) is **unresolved here and deferred to G4**; this spike does not specify it.

## 4. agentgateway (Solo.io / CNCF)

### 4.1 What it is

> "an open source proxy built on AI-native protocols (MCP & A2A) that provides drop-in security, observability, and governance for agent-to-LLM, agent-to-tool, and agent-to-agent communication across any framework and environment." — https://github.com/agentgateway/agentgateway
> "Agentgateway is an AI-first, open-source, cloud-native gateway control plane and proxy data plane, that was originally donated to the Linux Foundation in 2025 and was accepted as an Agentic AI Foundation (AAIF) project in 2026." … "It is a general-purpose HTTP and gRPC data plane with load balancing, timeouts, retries, TLS, rate limits, authorization, and traffic policies." — https://agentgateway.dev/docs/standalone/latest/about/introduction/
> Cargo: `edition = "2024"` / `rust-version = "1.90"` / `license = "Apache-2.0"` — https://github.com/agentgateway/agentgateway/blob/main/Cargo.toml ; LICENSE "Apache License Version 2.0" … "Copyright 2017 Solo.io, Inc." — https://raw.githubusercontent.com/agentgateway/agentgateway/main/LICENSE

Governance: Linux Foundation / AAIF ("the fourth hosted project under the Linux Foundation" — https://www.solo.io/blog/agentgateway-joins-aaif-as-an-open-gateway-for-agentic-ai-infrastructure). CNCF membership: NOT FOUND (the brief's "CNCF" is not supported by the sources). Security policy: "User-written policy is the user's responsibility." … "External policy components are trusted, at least in part. ext-auth, ext-proc, external rate limiting, and similar configured services are expected to behave correctly." — https://github.com/agentgateway/agentgateway/blob/main/SECURITY.md

### 4.2 The "STS": token exchange, not a credential store — and no KEK/DEK/KMS

The brief asked about "STS with KEK/DEK + KMS". In the public docs, blog and release workflow, **KEK, DEK, KMS, envelope encryption and any secret-store integration are NOT FOUND**. What agentgateway calls backend auth is a set of per-route strategies that source the outbound credential from env, file or a Kubernetes Secret, or mint one by exchanging the inbound token at an external IdP:

> "Backend authentication is how the gateway proves its own identity to an upstream service. Client authentication is the opposite direction: how a client proves its identity to the gateway." … Static key — "a value that you configure, or a Secret or file that you control"; Passthrough — "Sends the client credential on to the backend unchanged"; Signed JWT — "A JWT signed by your private key, fresh on every request"; OAuth token exchange — "A narrower token, derived from the client's credential at one authorization server"; Cross App Access — "Token exchange across a trust boundary, using the OAuth Identity Assertion Authorization Grant" … "Prefer a Secret or a file over an inline value, so that the credential is not stored in the configuration." — https://agentgateway.dev/docs/standalone/latest/configuration/security/backend-authn/

> `grantType: tokenExchange` (RFC 8693, default) — "The incoming credential is sent as `subject_token`"; `grantType: jwtBearer` (RFC 7523) — "sends the incoming credential as the `assertion` instead of the `subject_token`" … client auth `privateKeyJwt` — "Agentgateway signs a short-lived JWT with your private key on each token request, so no secret is stored in the configuration" … "`cache` | In-memory token cache. Defaults to 8192 entries with a 300-second TTL when the response omits `expires_in`. Set `maxEntries: 0` to disable." — https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/backend-authn/oauth-token-exchange.md

> Cross App Access: "The inbound request carries the user's OIDC ID token, validated by the `jwtAuth` policy." … "The Bearer token is added as `Authorization: Bearer <token>` to the upstream request and cached until shortly before it expires." … "The inbound ID token was stripped and never reached the backend," — https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/backend-authn/cross-app-access.md

> Kubernetes inline value: "The value is stored in plain text in the cluster and in any Git repository that tracks the resource, so use a Secret instead wherever you can." — https://agentgateway.dev/docs/kubernetes/latest/documentation/security/backend-authn/key.md

Its optional database stores config and LLM records, and in hybrid mode UI-created provider API keys; the storage docs say nothing about encryption at rest:
> "sqlite://./data.db" or "postgres://user:password@host:5432/dbname" … stores "one record for each LLM request" — https://agentgateway.dev/docs/standalone/latest/documentation/setup/database.md ; hybrid mode "stores the resource in the database" for LLM "providers, models, virtual models, API keys, policies" — https://agentgateway.dev/docs/standalone/latest/documentation/setup/storage.md

**Custody reading:** agentgateway is not a credential plane by design — it holds long-lived secrets only as env/file/K8s Secret references and exchanged tokens only in an in-memory cache. That is a virtue for the custody rule (nothing new at rest) and a limitation for our need: it cannot store a user's per-account credential; the RFC 8693/7523 model assumes the *provider's* authorization server will exchange our caller's identity for a downstream token, which is true for enterprise IdPs (Okta/Entra/Keycloak) and false for the consumer/API providers agent accounts target (GitHub PATs, Stripe keys, a site login). The one place it stores anything (hybrid-mode API keys in SQLite/Postgres, no encryption statement) would fail the plane bar if used.

**Answer (requirement 1):** plaintext never returns to the caller — "After it validates a token, agentgateway removes the token from the location that it was read from, so that the backend never receives the client's credential." (https://agentgateway.dev/docs/standalone/latest/configuration/security/jwt-authn/) — and the outbound credential flows only proxy → backend. It reaches our web process only if our web process is the backend.

### 4.3 Identity from the IdP `sub`

> "The **issuer** verifies that tokens come from the specified issuer (`iss`). Agentgateway rejects a token from another issuer, and it also rejects a token that has no `iss` claim." … "The **audiences** lists allowed audience values (`aud`)." … modes Strict / Optional (default) / Permissive — https://agentgateway.dev/docs/standalone/latest/configuration/security/jwt-authn/
> CEL: `jwt` "contains the claims from a verified JWT token." with `rawToken` "Redacted by default"; `source` carries a SPIFFE identity; `extauthz` "contains dynamic metadata from ext_authz filters." — https://agentgateway.dev/docs/standalone/latest/reference/cel/cel-context/
> "HTTP authorization allows defining rules to allow or deny requests based on their properties, using CEL expressions." e.g. `require: 'jwt.aud == "my-service"'` — https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/http-authz.md ; out-of-process: "When authorization decisions need to be made out-of-process, use an external authorization policy." — https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/external-authz.md
> v1.5.0 adds "SPIFFE Workload API identities" — https://github.com/agentgateway/agentgateway/releases/tag/v1.5.0

*Inference:* identity is whatever JWT the caller presents. For a hostile guest that is a guest-held bearer again (Λ6); the ext_authz hook is the one seam where our authority could be consulted per request — but "Tool arguments are not available during authorization" (below), so a canonical request digest over the body cannot be enforced there.

### 4.4 MCP gateway overlap

> "Multiplexing combines multiple MCP servers (targets) within a single backend into one unified MCP server." — https://agentgateway.dev/docs/standalone/latest/mcp/connect/virtual/
> "The MCP backend verifies access to the MCP server tools. By default, all tool access is allowed." … `'jwt.sub == "alice" && mcp.tool.name == "add_issue_comment"'` — https://agentgateway.dev/docs/kubernetes/latest/mcp/tool-access/
> "If a tool or other resource is not allowed, the gateway automatically filters it from the `list` response, so unauthorized clients never see it." … "Tool arguments are not available during authorization" — https://agentgateway.dev/docs/standalone/latest/documentation/configuration/security/mcp-authz.md
> "Agentgateway acts as a resource server: it validates the tokens that your authorization server issues, serves the protected resource metadata that MCP clients discover" — https://agentgateway.dev/docs/standalone/latest/mcp/mcp-authn/ (RFC 8414, 7591 DCR, 8707; MCP spec `2026-07-28`)
> Guardrails: external processor sees "the JSON-RPC method name, the target backend, the request or response parameters, and selected request headers"; actions Pass / Mutate / Deny; `failureMode: failClosed` — https://agentgateway.dev/docs/standalone/latest/documentation/mcp/guardrails/about.md

*Inference:* this is the overlap with our L4 relay: for MCP-shaped traffic from a sandbox, agentgateway already does per-tool RBAC, list filtering, resource-server OAuth and a deny-capable pre-execution hook (guardrails see the params; authz does not). It does not cover plain HTTP with a stored credential, git smart-HTTP, or a browser. If a later gate adds MCP servers to agent sessions, agentgateway is a candidate data plane behind our authority; it is not a candidate for L2/L3.

### 4.5 Runtime footprint, onprem, provenance (Λ12)

> `curl -sL https://agentgateway.dev/install | bash` … `agentgateway -f config.yaml` … "Agentgateway watches the file and reloads it when you change it" — https://agentgateway.dev/docs/standalone/latest/documentation/setup/install/binary.md
> `docker run … -p 4000:4000 cr.agentgateway.dev/agentgateway:v1.5.0` … "creates a SQLite database alongside it." — https://agentgateway.dev/docs/standalone/latest/setup/install/docker.md ; Helm charts `oci://cr.agentgateway.dev/charts/agentgateway` v1.5.0, xDS control plane on Kubernetes Gateway API — https://agentgateway.dev/docs/kubernetes/latest/documentation/install/helm.md
> Benchmarks (vendor): "agentgateway handled **over 11× more requests per second** while maintaining sub-2 ms P99 latency." … "agentgateway stayed below **30 MB**." — https://agentgateway.dev/blog/2026-06-26-benchmarking-agentgateway-vs-litellm/

Onprem: fully self-hostable OSS (binary, Docker, Helm); "Solo Enterprise for agentgateway" adds "automatic token exchange, cryptographically verifiable audit trails", "24x7 support and hardened distribution" — https://www.solo.io/blog/introducing-solo-enterprise-for-agentgateway ; price unpublished ("Contact Sales").

Provenance: v1.5.0 (2026-08-27), v1.4.1 (07-29), v1.4.0 (07-27); v1.6.0-alpha.1 (09-14) "expected in roughly 2 weeks" — https://github.com/agentgateway/agentgateway/releases ; maintainer: "We are planning a 1month cadence for releases though!" — https://github.com/agentgateway/agentgateway/discussions/1935 ; release workflow: `cosign sign --yes ${{ env.REGISTRY_IMAGE }}:v${{ env.VERSION }}` and `cosign attest --predicate "${{ env.VEX_FILE }}" --type openvex` on the controller, `linux/amd64` + `linux/arm64` — https://raw.githubusercontent.com/agentgateway/agentgateway/main/.github/workflows/release.yml ; SBOM / SLSA provenance: NOT FOUND. Registry `cr.agentgateway.dev` (GHCR mirror). Advisory in 1.5.0: GHSA-g7j8-wp7h-wmgr (cross-namespace delegation now requires `ReferenceGrant`).

Audit: access logs to stdout per request, Prometheus on :15020, OTLP traces; `mcp.tool.arguments` / `mcp.tool.result` are "Post-request" variables — https://agentgateway.dev/docs/standalone/main/mcp/mcp-observability/. Audit acceptance before execution: not provided (guardrails can deny, but nothing durably records-then-executes).

## 5. Plaintext-residency summary (requirement 1)

| Candidate | Returns plaintext to our web process? | To the sandbox? | Proof |
|---|---|---|---|
| Nango | Yes on demand: `GET /connections/{id}` returns `credentials.access_token`; `refresh_token=true` adds the refresh token; any environment API key | Only if we forward it | §1.4 quotes (docs + `getConnection.ts`) |
| Infisical store | To whichever identity resolves — by our design only the executor's identity; the web app holds no reading identity (Codex #2) | Never | §2.2 identity scoping; §2.4 `GET /api/v4/secrets/{name}` returns `secretValue` to an authorized identity |
| Agent Proxy | No — substituted in the proxy process | No — vendor default: placeholder + CA + proxy address + `connect` bearer (§3.3); v1 relay-only: nothing in the sandbox | §3.1 "the agent has no access at all to the process holding the real credentials." |
| Agent Vault | No — "No credential value stored in the vault is ever returned in an API response or written to a log." | No | §3.2 |
| agentgateway | No — the inbound token is stripped after validation; the exchanged/static outbound credential flows only to the backend | No | §4.2 jwt-authn quote; oauth-token-exchange.md |

## 6. What each candidate does NOT do that the Codex design requires — what we still build

The design (epic "Security review… what it changed", items 2, 4, 5, 12; Control Board §1 shapes) needs: an **authorization authority** issuing bounded action grants (issuer, audience, tenant, delegation, agent, run, sandbox instance+generation, account+credential version, policy version, operation, **canonical request digest**, approval id, expiry, nonce, presenter key); a **credential executor** that validates the grant independently, resolves, acts, filters; **approval bound to the digest** (allow-once / always / deny); **durable audit acceptance before execution**; **caller identity from a trusted transport outside the guest**; **replay state atomic across replicas**.

| Requirement | Nango | Infisical store | Agent Proxy / Agent Vault | agentgateway |
|---|---|---|---|---|
| Caller-bound grants (who may use *this* account *now*) | no — environment key | no — identity → project role is standing, not per-request | no — per-instance identity / per-agent session token, standing | partial: per-request JWT + CEL on the *caller*; ext_authz hook could consult our authority, but not over the body (§4.3) |
| Canonical request digest; approve one representation, execute the same | no | no | no — substitutes into whatever request arrives | no |
| Approval binding (allow-once/always/deny to a digest) | no | approval workflows exist for *secret changes* (Enterprise), not for use | no | no |
| Audit acceptance before execution | no (observability after) | no (audit after, tiered) | no (request logs after) | no (access logs / OTel after) |
| Sandbox identity bound outside the guest | n/a | n/a | no — env/bearer inside the guest | no — bearer JWT presented by the guest |
| Replay protection across replicas | refresh lock via Redis (for refresh, not for use) | no | no | no |
| Typed operation semantics ("ask on write" ≠ method) | no | no | host[:port][/path] rules only | route/tool-level policy for MCP (§4) |
| OAuth refresh lifecycle (RFC 9700 rotation, CAS, crash recovery, revocation) | yes, minus CAS on rotation and minus a documented rotation guarantee | no | Agent Vault yes (refresh at proxy time); Agent Proxy not found | no |
| OAuth authorization-code flow, provider catalogue | yes (1,000+) | no | no | no |

So the build list is the same under every choice: `grant.ts`, `canonical-request.ts`, the approval binding, `audit.ts` with acceptance-before-execute, the replay store, the store adapter with our own CAS (§2.4), the OAuth refresh worker (unless Nango), and the L4 channel binding (S1).

**Onprem follow-up for L2·G2 (from PR #2633 round 3; the §9 compose path is BLOCKED on it):** `infrastructure/scripts/tenant-stack.sh` must gain the two Docker network operations the §9 `vault-ingress` design assumes, because today `up` and `down` (lines 86–105) run only `docker compose up -d` and `docker compose down`. Concretely: on `up`, after `compose up -d`, run `docker network connect vault_ingress_${TENANT_SLUG} "$TRAEFIK_ID"`, where `TRAEFIK_ID=$(docker compose -f "${SCRIPT_DIR}/docker-compose.traefik.yml" ps -q traefik)` (`SCRIPT_DIR` is the script's absolute `infrastructure/` dir, line 4). This assumes Traefik was started from that file under its default project name; if `TRAEFIK_ID` is empty the script must fail loudly, not connect nothing. The Traefik service sets no `container_name`, so the literal name `traefik` does not exist; compose names it `<project>-traefik-1`. Guard the connect to be idempotent on re-runs: skip when `docker network inspect vault_ingress_${TENANT_SLUG} --format '{{range $id, $c := .Containers}}{{$id}} {{end}}'` already lists that id. On `down`, before `compose down`, run `docker network disconnect vault_ingress_${TENANT_SLUG} "$TRAEFIK_ID"`, tolerating the already-disconnected case so cleanup still completes after a failed `up`. The `down` ordering matters: compose cannot remove `vault_ingress_${TENANT_SLUG}` while the foreign Traefik endpoint is still attached. Acceptance: `tenant-stack.sh up` twice in a row succeeds, `docker network inspect vault_ingress_${TENANT_SLUG}` lists exactly two containers, the Traefik container (by id) and this project's `vault-ingress` container (`<project>-vault-ingress-1`), `vault-${TENANT_SLUG}.<apex>` answers through Traefik, and `tenant-stack.sh down` removes the network. Until this lands the vault-ingress deployment path in §9 is PROPOSED, not deployable.

The vendors remove: the encrypted store and key hierarchy (Infisical), the substitution-at-egress mechanics (Agent Proxy), and — only with Nango — the provider catalogue and auth-code flow. RFC 9700 on rotation, for the worker we build: "Refresh tokens for public clients MUST be sender-constrained or use refresh token rotation" — https://www.rfc-editor.org/rfc/rfc9700.html §2.2.2 (replay of a rotated refresh token → revoke the whole grant).

## 7. D-24 ruling — evidence, options, recommendation

**Question:** can Nango's token store be externalized? **No** (§1.3). Then: isolate it to the plane bar, or drop it and build the OAuth refresh lifecycle on Infisical ourselves?

### 7.1 Option A — isolate Nango as a second plane (the runner-up)

Meets the bar only with all of: own Fly custom private network (`fly apps create <app name> --network <network name>`; "Apps on separate 6PNs can never communicate unless explicitly configured to do so." — https://fly.io/docs/networking/custom-private-networks/), own Managed Postgres ("A highly-available Postgres cluster within your Fly.io organization's private network", "Automatic encryption of data at rest and in transit" — https://fly.io/docs/mpg/overview/), own Upstash Redis for the refresh lock ("available in all Fly regions via a private IPv6 address restricted to your Fly organization" — https://fly.io/docs/upstash/redis/), a KMS-wrapped DEK (needs an AWS/GCP account; Fly has no KMS), a dedicated egress IP for provider allowlists, and one Nango environment or instance per tenant for reader scoping (§1.6). Plus our own gate in front of `GET /connections` so the web process never calls it (a policy — see §1.4). Cost in §8.2. Operational: patch cadence weekly-to-fortnightly, unsigned images, no key rotation, ELv2 review, Connect UI phone-home (§1.8), webhooks/RBAC/MFA behind an unpublished Enterprise fee.

### 7.2 Option B — drop Nango; refresh lifecycle in our restricted worker on Infisical (the recommendation)

What we give up: the provider catalogue and hosted auth-code flow. What we already have: `packages/lib/src/integrations/oauth/oauth-handler.ts` (with `refreshOAuthToken`, zero callers today) for the OAuth2 providers we ship (GitHub, Notion and Slack under `packages/lib/src/integrations/providers/`; Google Calendar and Zoom under `apps/web`) and the `integration_connections` model G3 migrates. What we add: one worker (Control Board §7 shapes) that serializes per account, rotates with our own CAS over `secret.version` (§2.4), recovers from crash mid-refresh (write-then-swap), revokes, honours RFC 9700, and is the only holder of a refresh-capable identity. G3 already words this as "ours otherwise".

### 7.3 Why B wins, why A lost

Scoring the plane bar row by row (the compact RTC pass, rendered as prose): store — A keeps a second ciphertext store with an unrotatable key, B has one; keys — A adds a KMS account outside Fly, B uses the hierarchy D-17 already chose; network — tie once A's custom 6PN is built; reader identity — **A fails structurally** (environment-scoped keys that can read plaintext), B passes with per-tenant machine identities; audit before use — neither vendor provides it, tie (ours). A wins only the provider-catalogue row, and that row is not on the epic's critical path: L2's thin slice is an `api_key` account, L3 migrates a handful of providers we already implement. The custody rule says a component that cannot meet the bar "is not used"; A's shortfall on reader identity is not a configuration gap, so A is the runner-up on the merits and only becomes attractive if a later epic needs hundreds of OAuth providers — at which point Nango *cloud* (per-connection pricing, their custody, their DPA) is the honest comparison, not a self-hosted second plane.

**Proposed answer to D-24 (for the orchestrator to record; this spike does not decide):** drop self-hosted Nango; Λ5 → *retired* (never provisioned); the OAuth refresh lifecycle is G3's restricted worker on Infisical; revisit as "Nango cloud vs our worker" if the provider catalogue becomes a product requirement.

## 8. Cost estimates (cloud, requirement 3)

All list prices quoted 2026-09-14. Assumptions are stated; they are ours, not the vendors'.

### 8.1 Infisical cloud as the store (D-21) + Agent Proxy on Fly

Infisical bills per identity, not per secret or per call (§2.6). Storage of 1k / 10k / 100k credentials therefore costs the same on paper; no per-secret cap was found. The cost driver is Λ4's **one machine identity per tenant**.

| Stored credentials | Assumed tenants (10 credentials per tenant) | Identities (tenants + 3 ops) | Pro, annual ($20/identity/mo) | Advanced, annual ($40/identity/mo) |
|---|---|---|---|---|
| 1,000 | 100 | 103 | $2,060 / mo | $4,120 / mo |
| 10,000 | 1,000 | 1,003 | $20,060 / mo | $40,120 / mo |
| 100,000 | 10,000 | 10,003 | $200,060 / mo | $400,120 / mo |

Reading of this table: identity-per-tenant on list pricing does not scale past a few hundred tenants. Before G2 binds to a tier the orchestrator needs either an Enterprise quote (custom, annual; also the tier that unlocks per-project external KMS and audit streaming) or a different tenant→identity mapping that still satisfies "no identity can read every tenant" (e.g. one identity per *shard* of tenants, with the shard boundary stated in the threat model as the blast radius). That is a [D-n]-shaped fork; flagged, not decided. Per-project data keys are free at every tier, so key isolation does not depend on the answer.

1M broker calls / month: Agent Proxy resolves against Infisical with the proxy's identity and caches; Infisical publishes no per-call price and its rate limits are per plan (§2.6). Compute for the proxy on Fly: two `shared-cpu-1x` 1GB machines "$5.92" each = ~$12/mo; a dedicated IPv4 "$2/mo"; outbound "$0.02 per GB" (NA/EU) — https://fly.io/docs/about/pricing/. At an assumed 20 KB per call, 1M calls ≈ 20 GB ≈ $0.40. **≈ $15/month** for the broker path at 1M calls, dominated by fixed compute.

### 8.2 Nango, for comparison

Cloud PAYG "$0.29 / connection": 1k = $290/mo, 10k = $2,900/mo, 100k = $29,000/mo (Enterprise "as low as $0.01/connection/month at scale" → $1,000/mo at 100k). 1M proxy calls: no per-proxy-call price published; compute is billed "$0.72 / hour" for functions, NOT FOUND for proxy.

Self-hosted second plane (option A), flat regardless of credential count: `nango-server` on one `shared-cpu-1x` 2GB "$11.11"; Managed Postgres Basic "$38.00" + "$0.28 per provisioned GB"; Upstash Redis fixed 250MB "$10/mo"; dedicated IPv4 "$2/mo"; AWS KMS key ≈ $1/mo + requests (AWS list, not quoted here); custom 6PN: no price found. **≈ $65–75/month** for one instance — times the number of tenant-scoped instances if §1.6 is solved by instance-per-tenant, plus the unpublished Enterprise fee if syncs/webhooks/RBAC are needed.

## 9. Onprem (deprioritized, D-21): compose join and gated env vars (requirement 2)

Documented so the path exists; it does not drive the recommendation. The snippet joins `infrastructure/docker-compose.tenant.yml` (`networks: internal` is `internal: true`; `traefik` is external; Traefik labels use `${TENANT_SLUG}`). It adds a **third network, `credential_plane`**, and the store, its Postgres and its Redis have an interface on **that network only**: `web`, `processor` and `realtime` never join it, and `agent-proxy` is the sole bridge — the plane's "own network segment". *Amended 2026-09-15 (PR #2633 review)*: the first draft attached `infisical` to the external `traefik` network to carry its ingress labels. That broke the boundary it claimed — `web` and `realtime` already join `traefik` (`docker-compose.tenant.yml`), and so does every other tenant project on the host, so Infisical's port would have been reachable laterally from the app containers of this and other tenants. The corrected snippet keeps `infisical` off `traefik` and exposes the UI through a **`vault-ingress` sidecar**: a reverse proxy that carries the Traefik labels and forwards only HTTP to `infisical:8080`. *Amended again 2026-09-15 (round 2)*: the sidecar itself must **not** join `traefik` either — every tenant project on the host joins that network, so a sidecar on it hands a compromised app container of any tenant a route to Infisical's HTTP surface, and authentication on that surface does not restore the network isolation the plane is supposed to have. The sidecar therefore joins `credential_plane` plus a **dedicated per-tenant ingress network, `vault_ingress_${TENANT_SLUG}`** (`internal: true`, named explicitly so the compose project prefix does not rename it), to which **only the shared Traefik container is connected**. **Status: PROPOSED / BLOCKED (PR #2633 round 3).** That connection does not exist today: `infrastructure/scripts/tenant-stack.sh` (lines 86–105) runs only `docker compose up -d` on `up` and `docker compose down` on `down`, so as written the Traefik container has no interface on `vault_ingress_${TENANT_SLUG}`, `vault-${TENANT_SLUG}.<apex>` is unreachable, and this deployment path must not be enabled. Unblocking it is a two-line change to the script, listed as an L2·G2 follow-up in §6: after `compose up -d`, connect the Traefik container **by id**, resolved with `docker compose -f "${SCRIPT_DIR}/docker-compose.traefik.yml" ps -q traefik` (the service has no `container_name`, so there is no container literally named `traefik`), guarded so a re-run is idempotent by matching that id in `docker network inspect`; before `compose down`, disconnect the same id (tolerating "not connected" so a partial `up` still tears down, and ordered before `down` because compose cannot remove a network that still has a foreign endpoint). This PR is docs-only and does not change the script. The sidecar carries `traefik.docker.network=vault_ingress_${TENANT_SLUG}` because `traefik.yml`'s docker provider defaults to `network: traefik` for backend addresses. The isolation claim is exactly this. **Apart from the shared Traefik container, which is connected to `vault_ingress_${TENANT_SLUG}` on purpose, and `agent-proxy`, which bridges `internal`, no container of this tenant or any other has an interface on `vault_ingress_${TENANT_SLUG}` or `credential_plane`.** No app container therefore has a *direct network route* to the store, its DB, its Redis or the sidecar. That is not the same as "cannot reach": `web`, `processor`, `realtime` and `cron` sit on `internal` next to `agent-proxy`, a forward proxy that can dial `credential_plane` hosts. Their reach through it is gated by the proxy's `connect` authentication, not by the network. G2 must therefore also make the proxy refuse `infisical`, `infisical-postgres`, `infisical-redis` and `vault-ingress` as destinations. Whether Agent Proxy can express a destination denylist is **not verified**; if it cannot, the executor-only identity ("Relay-side `connect` identity" below) is the whole control. The sidecar can still narrow the public surface further (IP allowlist, forward-auth, or a path allowlist for the UI/login routes). The proxy's `start` identity, which resolves secrets, lives only in `agent-proxy`. The executor's `connect` identity is a second identity, and it is a resolving one too if G2 finds that `connect` needs secret-read ("Relay-side `connect` identity" below). The Infisical UI is exposed on its own host, not under the tenant's app host, so a tenant's app session can never be a vault session.

```yaml
# --- credential plane (Agent Accounts epic; onprem path, D-21 deprioritized) ---
# Joins docker-compose.tenant.yml. web/processor/realtime stay on `internal` (+ `traefik`
# for web/realtime) and never join `credential_plane`; only the agent-proxy bridges
# `internal` and `credential_plane`. infisical / its postgres / its redis are on
# `credential_plane` ONLY — never on the shared external `traefik` network, which
# web, realtime and every other tenant project on the host also join. The UI reaches
# Traefik through the `vault-ingress` sidecar below.
#
# NOT DEPLOYABLE AS WRITTEN (spike illustration): images are pinned by TAG and
# `infisical/cli:0.0.0` is a placeholder. §10's ASI04 rule applies before this joins
# the tenant compose — every image below must be pinned by `@sha256:` digest, and that
# digest pinning is a prerequisite for closing G1b (store) and G4 (agent-proxy).
services:
  infisical-postgres:
    image: postgres:17.5-alpine            # same pin as the app DB
    restart: unless-stopped
    volumes:
      - infisical_postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: infisical
      POSTGRES_USER: infisical
      POSTGRES_PASSWORD: ${INFISICAL_POSTGRES_PASSWORD:?INFISICAL_* missing from .env - see infrastructure/UPGRADE.md (credential plane)}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U infisical -d infisical"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy: { resources: { limits: { memory: 200M } } }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    networks: [credential_plane]

  infisical-redis:
    image: redis:7.2.4
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    deploy: { resources: { limits: { memory: 64M } } }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    networks: [credential_plane]

  infisical:
    image: infisical/infisical:v0.165.10   # pinned; upgrade via UPGRADE.md, never :latest
    restart: unless-stopped
    depends_on:
      infisical-postgres: { condition: service_healthy }
      infisical-redis: { condition: service_started }
    expose: ["8080"]
    environment:
      ENCRYPTION_KEY: ${INFISICAL_ENCRYPTION_KEY:?INFISICAL_* missing from .env - see infrastructure/UPGRADE.md (credential plane)}
      AUTH_SECRET: ${INFISICAL_AUTH_SECRET:?INFISICAL_* missing from .env - see infrastructure/UPGRADE.md (credential plane)}
      DB_CONNECTION_URI: postgres://infisical:${INFISICAL_POSTGRES_PASSWORD}@infisical-postgres:5432/infisical   # password is interpolated UNENCODED: it MUST come from a URI-safe alphabet (see env template note)
      REDIS_URL: redis://infisical-redis:6379
      SITE_URL: https://vault-${TENANT_SLUG}.pagespace.ai
      LICENSE_KEY: ${INFISICAL_LICENSE_KEY:-}     # offline key accepted in the same var (docs/self-hosting/ee)
      TELEMETRY_ENABLED: "false"             # "if you want to disable it, you may set this to `false`." — docs/self-hosting/configuration/envars
    deploy: { resources: { limits: { memory: 768M } } }
    read_only: true
    tmpfs: ["/tmp:noexec,nosuid,size=100m"]
    security_opt: ["no-new-privileges:true"]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    networks: [credential_plane]             # ONLY here — no interface on `traefik` or `internal`

  # UI/API ingress for the vault host. Forwards HTTP to infisical:8080 and nothing else.
  # It is NOT on the shared `traefik` network (every tenant project joins that one): it sits
  # on the per-tenant `vault_ingress_${TENANT_SLUG}` network, which only the shared Traefik
  # container joins. PROPOSED / BLOCKED: tenant-stack.sh does NOT do this yet (it only runs
  # `compose up -d` / `compose down`, lines 86–105); L2·G2 adds
  # `docker network connect vault_ingress_${TENANT_SLUG} <traefik container id>` after `up` and
  # the matching disconnect before `down` (id via `compose -f docker-compose.traefik.yml ps -q traefik`; §6, §9).
  # Until then Traefik cannot reach this sidecar. No app container of this or any other
  # tenant has a route to this sidecar, to infisical, or to its DB/Redis.
  vault-ingress:
    image: nginx:1.28.0-alpine               # pin the real tag at G1b
    configs:
      - source: vault_ingress_nginx
        target: /etc/nginx/conf.d/default.conf   # replaces the stock welcome-site config
    restart: unless-stopped
    depends_on:
      infisical: { condition: service_started }
    expose: ["80"]
    read_only: true
    tmpfs: ["/var/cache/nginx", "/var/run", "/tmp:noexec,nosuid,size=16m"]
    security_opt: ["no-new-privileges:true"]
    deploy: { resources: { limits: { memory: 32M } } }
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${TENANT_SLUG}-vault.rule=Host(`vault-${TENANT_SLUG}.pagespace.ai`)"
      - "traefik.http.routers.${TENANT_SLUG}-vault.entrypoints=websecure"
      - "traefik.http.routers.${TENANT_SLUG}-vault.tls.certresolver=le"
      - "traefik.http.services.${TENANT_SLUG}-vault.loadbalancer.server.port=80"
      - "traefik.docker.network=vault_ingress_${TENANT_SLUG}"   # provider default is `traefik` (traefik.yml); the sidecar is not on it
    networks: [credential_plane, vault_ingress]   # never `traefik`

  # The egress broker. Bridges `internal` (so the server-side executor can reach
  # it), `credential_plane` (so it can reach Infisical) and `plane_egress` (its only
  # route to external providers). Holds the `start`
  # identity that resolves secrets; the executor's `connect` identity may also be
  # resolving (unverified; see "Relay-side `connect` identity" in §9). v1 is relay-only (D-18): the
  # sandbox never reaches or authenticates to this proxy; any sandbox-originated
  # proxy auth is deferred to G4 (§3.3 item 2).
  agent-proxy:
    image: infisical/cli:0.0.0               # "The CLI ships as the `infisical/cli` image."; pin the real tag at G4 (docs use :latest)
    command: ["secrets", "agent-proxy", "start", "--domain", "http://infisical:8080"]
    restart: unless-stopped
    depends_on:
      infisical: { condition: service_started }
    expose: ["17322"]                        # default listen port per the standalone-agent-proxy docs
    environment:
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: ${AGENT_PROXY_CLIENT_ID:?AGENT_PROXY_* missing from .env - see infrastructure/UPGRADE.md (credential plane)}
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: ${AGENT_PROXY_CLIENT_SECRET:?AGENT_PROXY_* missing from .env - see infrastructure/UPGRADE.md (credential plane)}
    deploy: { resources: { limits: { memory: 256M } } }
    security_opt: ["no-new-privileges:true"]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    networks: [internal, credential_plane, plane_egress]   # plane_egress = its ONLY route to external providers

networks:
  credential_plane:
    driver: bridge
    internal: true
  vault_ingress:
    name: vault_ingress_${TENANT_SLUG}   # explicit: `-p ${PROJECT}` would otherwise prefix it; the L2·G2 tenant-stack.sh change (§6) connects the Traefik container by this name — not implemented yet
    driver: bridge
    internal: true                      # Traefik reaches the sidecar over it; the sidecar needs no egress
  plane_egress:
    driver: bridge                      # NOT internal: `internal` and `credential_plane` are both `internal: true`, so without
                                        # this network the egress broker could not reach GitHub or any other provider.
                                        # agent-proxy is its only member, so this is the plane's single outbound path.
                                        # The network itself is unrestricted (Docker host, host-published 80/443,
                                        # RFC1918). G2 must add a provider-destination allowlist on the proxy and deny
                                        # host/private addresses; that is not verified as expressible in Agent Proxy.

configs:
  vault_ingress_nginx:                  # inline `content` needs Docker Compose >= 2.23.1
    content: |
      map $$http_upgrade $$connection_upgrade { default upgrade; '' close; }
      server {
        listen 80;
        location / {
          proxy_pass http://infisical:8080;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $$http_upgrade;
          proxy_set_header Connection $$connection_upgrade;
          proxy_set_header Host $$host;
          proxy_set_header X-Forwarded-Proto https;
          proxy_set_header X-Forwarded-For $$proxy_add_x_forwarded_for;
        }
      }

volumes:
  infisical_postgres_data:
```

`web` gets one addition only: `AGENT_PROXY_URL: http://agent-proxy:17322` (an address, no secret). No store URL and no machine identity go into `web`'s environment — the web process holds no store identity (Codex #2). The proxy's `start` identity lives with the proxy container. The executor's `connect` identity is placed and classified by the block below.

**Relay-side `connect` identity: UNSPECIFIED, and G2 must close it before any credentialed operation (PR #2633 round 4).** Agent Proxy authenticates **both** ends (§3.0: `start` on the proxy **and** `connect --client-id/--client-secret` on the caller side). Under relay-only v1 (D-18) the caller is the server-side runner, not the sandbox, but it is still a `connect` client. Nothing above gives it an identity: the compose credentials belong to the `agent-proxy` process, and `web` holds only an address. As written, the runner cannot open an authenticated connection. That is a gap in this spike, not a change to D-18. The shape G2 must pick and record:
- **Where the identity lives:** in the credential executor (the Control Board's sole caller of resolve), never in the general `web` environment. If the executor runs inside `web`, it gets its own process boundary, or the identity is injected at call time by the authority. Either way, "`web` holds no store identity" stays true of every non-executor code path.
- **What it may do:** one per-tenant Universal Auth identity (D-29 B), scoped to that tenant's project, with a TTL- and max-uses-bounded Universal Auth client secret (§2.2). That is the only `connect` auth the upstream docs show (`--client-id/--client-secret` or `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`/`_SECRET`, §3.3). OIDC machine-identity auth (§2.2) is **not** a documented `connect` option. It becomes one only if G2 verifies that `connect` accepts an OIDC-obtained access token, and documents the exchange step it needs. **Not verified:** whether Infisical requires the `connect` identity to hold secret-read permission on the proxied path. If it does, that identity can resolve plaintext, so it counts as a resolving identity under the custody rule and the executor is its only holder. If it does not, it is a non-resolving session identity. G2 verifies this against a sandbox project before binding.
- **Alternative:** if Agent Proxy cannot take a non-resolving caller, the executor resolves through the store adapter directly (G1b-store) and Agent Proxy is not used for the server-originated path.

**Env vars to append to `env.tenant.template` (all server-side, none `NEXT_PUBLIC_`):** `INFISICAL_POSTGRES_PASSWORD=__GENERATE__` — **URI-safe alphabet only**: it is interpolated unencoded into `DB_CONNECTION_URI`, so a reserved character (`@`, `/`, `#`, `:`, `?`) would re-parse the authority or truncate the password; `generate-tenant-env.sh` must emit it with `alnum_secret 32` (`[a-zA-Z0-9]`, the same helper the app's `POSTGRES_PASSWORD` already uses at `:64`), never `hex_secret`'s peer `openssl rand -base64`; `INFISICAL_ENCRYPTION_KEY=__GENERATE__` ("Must be a random 16-byte hex string. Can be generated with `openssl rand -hex 16`." — https://infisical.com/docs/self-hosting/configuration/envars; the standard `infisical/infisical:v0.165.10` image pinned above. **FIPS mode differs:** "For FIPS-enabled deployments, `ENCRYPTION_KEY` must be a 256-bit base64-encoded key instead" (`openssl rand -base64 32`, `infisical/infisical-fips` image) — same page), `INFISICAL_AUTH_SECRET=__GENERATE__` ("Must be a random 32-byte base64 string."), `INFISICAL_LICENSE_KEY=` (optional; offline key), `AGENT_PROXY_CLIENT_ID=__SET_BY_PROVISIONER__`, `AGENT_PROXY_CLIENT_SECRET=__SET_BY_PROVISIONER__`. `UPGRADE.md` gets a "credential plane" section because the stack refuses to start without them (the `:?` form above), exactly as the Phase 1/2 admin DB vars do — and the same warning applies: regenerating `INFISICAL_ENCRYPTION_KEY` makes the vault permanently unreadable.

**What `infrastructure/scripts/__tests__/env-var-audit.test.ts` gates:** that test's three cases assert that client-side `.tsx`/`.ts` files never read `NEXT_PUBLIC_APP_URL` without a `WEB_APP_URL` guard. It does not enumerate server env vars. The vars above pass it trivially because none is `NEXT_PUBLIC_*`; the gate that would actually bite is `packages/lib/src/config/env-validation.ts` (`serverEnvSchema`), where `AGENT_PROXY_URL` should be added as an optional URL with the `.or(z.literal(''))` blank-means-unset convention the file already uses, so a blank value disables the feature rather than failing boot.

Onprem non-guarantee (Λ11) still holds: the operator who runs `infisical`, `agent-proxy` and the host can read everything; §2.3's licence-lapse behaviour is the other onprem-only hazard.

## 10. Λ12 — pinned versions, cadence, provenance

| Vendor | Pin (2026-09-14) | Cadence | Registry | Signing / SBOM / provenance | Licence |
|---|---|---|---|---|---|
| Infisical | `v0.165.10` (09-11) | near-daily patch tags | Docker Hub `infisical/infisical`, `infisical/infisical-fips`; `public.ecr.aws/p5f0g7h8/infisical` | git tags GPG-signed; image: none found | MIT + `ee/` Enterprise |
| Infisical Agent Proxy | ships in the platform / CLI; pin with the CLI image at G4 | as Infisical | as above | as above | as above |
| Agent Vault | `v0.39.3` (09-01) | monthly-ish (0.37.1 06-19 → 0.39.3 09-01) | Docker Hub `infisical/agent-vault`; GitHub releases | cosign keyless (`checksums.txt.sig`, OIDC issuer GitHub Actions) | MIT + `ee/` |
| Nango | `hosted-0.71.7` (09-11) | weekly-to-fortnightly | Docker Hub `nangohq/nango-server` | none found | ELv2 |
| agentgateway | `v1.5.0` (08-27) | monthly (stated) | `cr.agentgateway.dev/agentgateway`, GHCR mirror | cosign keyless on images; OpenVEX attest on controller; SBOM/SLSA none found | Apache-2.0 |

ASI04 review rule for every gate that binds a vendor: pin by digest, not tag; Dependabot/Renovate on the digest; a release note read before each bump; for unsigned images, our own SBOM scan (Snyk in Infisical's own workflow is `continue-on-error: true`).

## 11. Open items for the orchestrator (not decided here)

1. **D-22 wording**: "Infisical Agent Vault" names the standalone binary; the platform Agent Proxy is the one that keeps custody inside the D-21 store. This spike recommends Agent Proxy; the orchestrator decides whether that is a clarification or a new [D-n].
2. **Identity-per-tenant pricing** (§8.1) — *answered by D-29 (B: one identity per tenant, all tiers, free on self-host) and the D-21 revision; kept as the 2026-09-14 record:* list pricing makes per-tenant machine identities cost $20–40/tenant/month. Enterprise quote or a shard mapping — a founder-level fork.
3. **Custom roles tier** — *moot for self-hosted OSS under the D-21 revision unless G1b needs an EE-licensed feature; G1b confirms:* RBAC doc says Enterprise, pricing page says Advanced (§2.2). G1b's identity scoping depends on which.
4. **Proxy front door is public, but only if G4 adopts sandbox-originated requests** (§3.3): Sprites block private ranges, so a sandbox-called proxy needs a public hostname and load-bearing auth. Under v1 relay-only (D-18) the proxy is called only server-side and can stay private.
5. **Store CAS is ours** (§2.4): the adapter interface G1b freezes should not promise a CAS the backend lacks; name it "versioned write with post-write verification" or implement CAS in the plane's own metadata table.

## 12. Sources (all fetched 2026-09-14)

Nango: nango.dev/docs/guides/platform/{self-hosting,security,proxy-requests,environments}; /docs/guides/auth/{auth-guide,token-refreshing,connection-tags-configuration-metadata}; /docs/reference/api/{connections/get,connection/get,proxy/get,connect/sessions/create,authentication}; /docs/reference/api-configuration; /docs/reference/backend/backend-sdk/node; nango.dev/pricing; github.com/NangoHQ/nango — LICENSE, README, docker-compose.yaml, Dockerfile.self_hosted, scripts/build_docker_self_hosted.sh, .github/workflows/build-image.yaml, packages/shared/lib/utils/encryption.manager.ts, packages/shared/lib/env.ts, packages/shared/lib/services/connections/credentials/refresh.ts, packages/shared/lib/services/connections/utils.ts, packages/utils/lib/{encryption.ts,environment/parse.ts}, packages/kms/lib/{registry,envelope,gcp}.ts, packages/kvstore/lib/{index,Locking}.ts, packages/server/lib/controllers/connection/connectionId/getConnection.ts; releases; issues 5536, 5432, 6136; PR 7463; hub.docker.com/r/nangohq/nango-server.

Infisical: infisical.com/pricing, /security, /terms/self-hosted; /docs/internals/{security,architecture/cloud,permissions/project-permissions}; /docs/self-hosting/{overview,ee,deployment-options/docker-compose}; /docs/documentation/platform/identities/{overview,machine-identities,universal-auth}; /docs/documentation/platform/access-controls/{role-based-access-controls,additional-privileges}; /docs/documentation/platform/kms-configuration/{overview,aws-kms}; /docs/documentation/platform/{audit-logs,audit-log-streams/audit-log-streams,secret-versioning,secret-rotation/overview,dynamic-secrets/overview}; /docs/documentation/platform/agent-proxy/{overview,standalone-agent-proxy,proxied-services,quickstart/credentials}; /docs/integrations/app-connections/{overview,github}; /docs/api-reference/endpoints/secrets/{read,update,list} and deprecated/secrets/{read,update}; github.com/Infisical/infisical — LICENSE, backend/src/ee/LICENSE.md, backend/src/ee/services/license/{license-service.ts,license-fns.ts}, docker-compose.prod.yml, .github/workflows/release-standalone-docker-img-postgres-offical.yml, releases; hub.docker.com/r/infisical/infisical.

Agent Vault: github.com/Infisical/agent-vault (README, LICENSE, releases); docs.agent-vault.dev/{,guides/connect-custom-agent,learn/security,learn/credentials,learn/credential-stores,guides/oauth-claude-code,self-hosting/postgres,self-hosting/environment-variables}; infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents; prweb.com release 302749986.

agentgateway: github.com/agentgateway/agentgateway (README, LICENSE, Cargo.toml, SECURITY.md, CONTRIBUTION.md, .github/workflows/release.yml, releases v1.4.0–v1.6.0-alpha.1, discussions/1935, issues/2029); agentgateway.dev/docs/standalone/latest/{about/introduction,faqs,configuration/security/{backend-authn,jwt-authn},documentation/configuration/security/backend-authn/{key,jwt-sign,oauth-token-exchange,cross-app-access}.md,documentation/configuration/security/{http-authz,external-authz,oidc,apikey-authn,mcp-authn,mcp-authz}.md,mcp/{mcp-authn,connect/virtual},documentation/mcp/{spec-compatibility,guardrails/about,mcp-observability}.md,documentation/setup/{database,storage,install/binary}.md,setup/install/docker.md,reference/cel/{cel-context,variables},documentation/observability/{access-logs/view,metrics/overview,traces/setup}.md}; agentgateway.dev/docs/kubernetes/latest/{mcp/tool-access,documentation/security/backend-authn/key.md,documentation/install/helm.md,documentation/about/architecture.md}; agentgateway.dev/docs/kubernetes/main/reference/versions/; agentgateway.dev/blog/{2026-06-04-designing-agentgateway-unified-gateway,2026-06-26-benchmarking-agentgateway-vs-litellm,2026-07-12-agentgateway-token-exchange-jwt-assertion-entra-obo}; linuxfoundation.org press release (2025-08-25); solo.io/{blog/agentgateway-joins-aaif-…,blog/introducing-solo-enterprise-for-agentgateway,products/agentgateway}; aws.amazon.com/marketplace prodview-i4d6q4pxvksz2.

Fly: fly.io/docs/about/pricing/, /docs/mpg/overview/, /docs/upstash/redis/, /docs/networking/{private-networking,custom-private-networks}/. RFC 9700: rfc-editor.org/rfc/rfc9700.html.
