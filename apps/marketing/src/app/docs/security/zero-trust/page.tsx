import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Zero-Trust Architecture",
  description: "PageSpace zero-trust security: opaque session and service tokens, JTI revocation, OAuth PKCE, timing-safe comparisons, continuously verified audit log, SSRF and path-traversal hardening, and HMAC-signed cron endpoints.",
  path: "/docs/security/zero-trust",
  keywords: ["zero trust", "security architecture", "opaque tokens", "service tokens", "JTI revocation", "SSRF", "path traversal", "audit chain verification", "SIEM", "PKCE", "HMAC cron", "rate limiting"],
});

const content = `
# Zero-Trust Architecture

Every request is authenticated and authorized independently. Internal services validate the same kind of opaque token the browser sends, with scopes reduced to what the calling user actually has. Network location and prior hops grant no trust.

## Token Architecture

Every authentication token is an opaque random string, hashed at rest, validated by database lookup.

| Property | Behavior |
|---|---|
| Payload | Random string; claims come from the DB row |
| Revocation | Delete the row — effective on the next request |
| Size | ~60 bytes |
| Theft response | Revocable immediately; \`tokenVersion\` also invalidates all of a user's sessions at once |
| Storage | Only the SHA-256 hash is stored |

### Token Generator

The core generator lives at \`packages/lib/src/auth/opaque-tokens.ts\`. It produces tokens in the shape \`ps_{type}_{base64url}\` with 32 bytes (256 bits) of entropy, where \`{type}\` is one of \`sess\`, \`svc\`, \`mcp\`, or \`dev\`.

Two paths use their own generators:

| Token | Prefix | Generator | Entropy |
|-------|--------|-----------|---------|
| MCP | \`mcp_\` | \`generateToken('mcp')\` from \`token-utils.ts\` | 256 bits |
| Socket | \`ps_sock_\` | Route-local \`randomBytes(24)\` in \`/api/auth/socket-token\` | 192 bits |
| Magic link | \`ps_magic_\` | \`generateToken('ps_magic')\` | 256 bits |
| Unsubscribe | \`ps_unsub_\` | Route-local \`randomBytes(24)\` | 192 bits |

MCP tokens intentionally omit the \`ps_\` prefix because they're presented in external clients; the separation helps logs and regex filters distinguish user-issued API tokens from web sessions.

All tokens are:

- Stored as SHA-256 hashes, with a 12-character prefix alongside the hash for log correlation.
- Validated by hashing the presented value and looking up the hash.
- Compared with a timing-safe helper (\`packages/lib/src/auth/secure-compare.ts\`): both inputs are SHA-256'd and compared byte-wise with \`crypto.timingSafeEqual\`. Equal-length 32-byte buffers destroy any length or prefix-structure timing leak. Applied uniformly to magic-link verification, device-token lookup, auth-header checks, and CSRF verification.

## Service-to-Service Authentication

Internal services — web, realtime, processor — authenticate each other with **opaque service tokens** validated by the same \`sessionService\` that validates user sessions.

### How it works

1. The web app needs to call the processor for a specific user and resource (e.g., ingest an upload for page X).
2. It calls \`createValidatedServiceToken({ userId, resourceType, resourceId, requestedScopes })\` (\`packages/lib/src/services/validated-service-token.ts\`).
3. That helper:
   - Loads the user's actual permissions on the resource.
   - Filters the requested scopes down to those the user is authorized for.
   - Creates a session of type \`service\` (claims scoped to that resource, those granted scopes, and a short TTL — 5 minutes by default, 30 days cap).
   - Returns a \`ps_svc_...\` token.
4. The web app forwards the token as \`Authorization: Bearer ps_svc_...\` to the processor.
5. The processor's \`authenticateService\` middleware (\`apps/processor/src/middleware/auth.ts\`) calls \`sessionService.validateSession\` and rejects anything whose \`claims.type !== 'service'\`.
6. Per-route middleware (\`requireScope('files:write')\`) asserts the claim carries the scope the operation needs.

The user's identity flows through the claims on the service token. The processor does not hold a secret; it holds a connection to Postgres and uses the same session validation the web app uses for user sessions.

### What this buys you

- **Instant revocation of cross-service capability.** Deleting the session row disables the token in flight.
- **Least privilege.** A service token for page X with \`files:read\` cannot be replayed to write files or to access page Y.
- **Audit completeness.** Every service call carries a \`sessionId\` you can trace in \`security_audit_log\`.
- **No env-var sprawl.** New services need DB access, not another secret to rotate.

### JTI Revocation

Every service token issued is recorded by JTI in \`revoked_service_tokens\` (\`revoked_at = NULL\` on issuance). Revocation flips \`revoked_at\` to \`now()\`. \`isJTIRevoked\` fails closed — unknown JTIs and rows past their \`expires_at\` both count as revoked. Expired rows are pruned by a cron sweep so the table stays small without losing the revocation semantic.

Source: \`packages/lib/src/security/jti-revocation.ts\`.

## Session Management

### Session Lifecycle (web)

1. **Login** — issue \`ps_sess_...\`; store hash in \`sessions\`; set \`HttpOnly; Secure; SameSite=strict\` cookie (\`lax\` only when \`COOKIE_DOMAIN\` is configured in production).
2. **Request** — read cookie; hash; look up \`sessions\` row; check \`expiresAt\`; check \`users.tokenVersion\` match; check \`suspendedAt IS NULL\`; enforce optional idle timeout.
3. **Logout** — delete the session row; clear cookies.

There is no access/refresh pair on web sessions. A session is a single opaque token.

### Device Token Rotation

Device tokens — desktop and mobile clients — **do** rotate. The client presents its current token to \`POST /api/auth/device/refresh\` or \`POST /api/auth/mobile/refresh\`; the server issues a new token, marks the old one \`replacedByTokenId\`, and keeps it valid for a brief grace window so concurrent requests don't fail.

Rapid refresh attempts (same device re-refreshing within 60s of last use) lower the device's \`trustScore\`; combined with user-agent or IP changes, the score can drop low enough for an operator to force re-auth.

Source: \`packages/lib/src/auth/device-auth-utils.ts\`, \`packages/lib/src/auth/device-fingerprint-utils.ts\`.

### Global Invalidation

\`users.tokenVersion\` is the kill-switch. Every session row stores the user's \`tokenVersion\` at creation. On validation, \`sessionService\` compares the two and rejects any mismatch.

\`\`\`
Force logout everywhere → UPDATE users SET tokenVersion = tokenVersion + 1
                          → every existing session is rejected on next request
\`\`\`

Bumping \`tokenVersion\` is used by "log out everywhere", passkey/credential reset, and admin suspension.

## Rate Limiting

Rate limits are stored in Postgres (\`rate_limit_buckets\`) as a weighted two-bucket sliding window. The design is an ≈-Cloudflare/nginx sliding-window approximation — a single \`INSERT ... ON CONFLICT DO UPDATE\` per check, with the previous bucket weighted by how far into the current window the request is.

| Endpoint | Scope | Purpose |
|----------|-------|---------|
| Login | Per-IP + per-email | Throttle credential stuffing |
| Signup | Per-IP | Limit account creation |
| Magic-link send | Per-email + per-IP | Limit email-flood vectors |
| Token refresh (device / mobile) | Per-user | Limit rotation abuse |
| API routes | Per-user (route-specific) | Limit hot-looping |

Exceeding a bucket returns HTTP 429 with \`Retry-After\`. Progressive blocking extends the ban for repeated violators. In production, a storage-layer failure fails **closed** (deny with \`Retry-After\`) rather than opening the floodgates.

Source: \`packages/lib/src/security/distributed-rate-limit.ts\`.

## Audit Logging

\`security_audit_log\` captures authentication, authorization, data access, and admin events. Entries are linked into a SHA-256 hash chain — each row's \`eventHash\` incorporates the previous row's hash — so tampering with history is detectable by rehashing and comparing.

A Postgres advisory lock serializes chain writes so concurrent inserts can't race and produce a fork.

### Tamper Detection

The chain is not just detectable on demand; it is continuously re-verified:

- **Periodic full-chain sweep** — a cron route (\`/api/cron/verify-audit-chain\`) calls \`verifyAndAlert\`, which recomputes every entry's \`eventHash\` and checks every \`previousHash\` link. On break, a registered alert handler fires.
- **SIEM preflight verification** — the SIEM delivery worker re-verifies the hash chain over each batch *synchronously* before emitting to an external sink. A detected break short-circuits the emission and fires a \`source: 'preflight'\` alert — the tampered batch never leaves the system.

Source: \`packages/lib/src/audit/security-audit-chain-verifier.ts\`, \`packages/lib/src/audit/security-audit-alerting.ts\`, and \`apps/processor/src/services/siem-chain-verifier.ts\`.

### Event Taxonomy

The full enum lives at \`packages/db/src/schema/security-audit.ts\`. The categories you'll see:

| Category | Example events |
|----------|----------------|
| Authentication | \`auth.login.success\`, \`auth.login.failure\`, \`auth.logout\`, \`auth.session.created\`, \`auth.session.revoked\` |
| Tokens | \`auth.token.created\`, \`auth.token.revoked\`, \`auth.token.refreshed\` (emitted on device-token rotation, not on web sessions) |
| Devices | \`auth.device.registered\`, \`auth.device.revoked\` |
| Authorization | \`authz.access.granted\`, \`authz.access.denied\`, \`authz.permission.granted\`, \`authz.permission.revoked\`, \`authz.role.assigned\`, \`authz.role.removed\` |
| Data | \`data.read\`, \`data.write\`, \`data.delete\`, \`data.export\`, \`data.share\` |
| Admin | \`admin.user.suspended\`, \`admin.user.reactivated\`, \`admin.settings.changed\` |
| Security signals | \`security.anomaly.detected\`, \`security.rate.limited\`, \`security.brute.force.detected\`, \`security.suspicious.activity\` |

Each entry carries user ID (nullable for unauthenticated failures), IP, user agent, session ID, a resource reference where applicable, and a \`riskScore\` for downstream alerting. Email addresses are masked before write (\`packages/lib/src/audit/mask-email.ts\`) — the first two characters of the local part are retained, the rest is replaced with \`***\`, and the domain is preserved so operational debugging of OAuth, deliverability, and tenant issues stays possible without storing full PII.

## CSRF Protection

State-changing requests must present a CSRF token bound to the current session.

1. Client calls \`GET /api/auth/csrf\`.
2. Server validates the session cookie, then returns an HMAC-signed token that encodes the session ID.
3. Client includes the token in subsequent POST/PATCH/DELETE requests (header or body).
4. Server verifies the signature, checks the token binds to the active session, and rejects mismatches.

Source: \`packages/lib/src/auth/csrf-utils.ts\`, \`apps/web/src/app/api/auth/csrf/route.ts\`.

## Outbound Request Safety (SSRF)

Every server-side URL fetch runs through a validator that resolves the hostname, then checks every resolved IP against a blocklist before connecting.

Blocked:

- Loopback (\`127.0.0.0/8\`, \`::1\`) and localhost hostnames.
- RFC 1918 private ranges (\`10/8\`, \`172.16/12\`, \`192.168/16\`) and link-local (\`169.254/16\`).
- Cloud metadata endpoints: AWS \`169.254.169.254\`, AWS IMDSv2 IPv6 \`fd00:ec2::254\`, GCP \`metadata.google.internal\`, Azure \`168.63.129.16\`, Alibaba \`100.100.100.200\`.
- Non-HTTP(S) schemes: \`file://\`, \`gopher://\`, etc.

DNS resolutions return multiple A/AAAA records; the validator rejects the request if **any** resolved IP is blocked — a host that advertises a public IP first and a private IP second does not slip through. IPv4-mapped IPv6 (\`::ffff:127.0.0.1\`) is normalized before comparison.

Source: \`packages/lib/src/security/url-validator.ts\`.

## Path Traversal Safety

Filesystem paths from uploads, avatars, tenant exports, and migration scripts run through a validator before the filesystem is touched.

Blocked:

- Directory traversal (\`../\`).
- URL-encoded (\`%2e%2e%2f\`) and double- or triple-encoded (\`%252e%252e%252f\`) variants. The decoder caps iterations to prevent deep-encoding attacks.
- Null-byte injection (\`\\x00\`).
- Symlink escapes — paths are resolved via \`fs.realpath\` and rejected if the resolved target falls outside the configured base directory.
- Absolute paths when a base directory is configured.

Source: \`packages/lib/src/security/path-validator.ts\`. Used by \`apps/processor/src/api/upload.ts\` and \`apps/processor/src/api/avatar.ts\`.

## Cron Endpoint Hardening

Internal cron routes (audit-chain verification, expired-row sweeps, device-token cleanup, retention cleanup, etc.) are authenticated with **HMAC-SHA256** signed requests:

- Every request carries \`X-Cron-Timestamp\`, \`X-Cron-Nonce\`, and \`X-Cron-Signature\` headers.
- The server recomputes the signature using \`CRON_SECRET\` and compares with \`secureCompare\`.
- In production, a missing \`CRON_SECRET\` fails closed — the route returns \`503\` and no cron action runs.
- An internal-network origin check runs as a second, independent layer.

Expired rows are swept by \`/api/cron/sweep-expired\` — \`revoked_service_tokens\`, \`rate_limit_buckets\`, and \`auth_handoff_tokens\` (PKCE verifiers, OAuth exchange codes, passkey-register handoffs). Each table is swept in an isolated try/catch so one failure cannot block the others.

Source: \`apps/web/src/lib/auth/cron-auth.ts\`, \`apps/web/src/app/api/cron/sweep-expired/route.ts\`, \`packages/lib/src/security/auth-handoff-sweep.ts\`.

## Content Security

### HTML Sanitization

User-generated HTML is sanitized before render. Canvas pages render inside Shadow DOM, isolating arbitrary author styles and scripts from the rest of the app. Mentions and links are validated server-side before rendering.

### API Key Encryption

AI provider API keys are encrypted with AES-256-GCM using scrypt-derived keys, a unique salt per write, and a unique IV per encryption. Keys are decrypted only on the request path that makes the provider call, never exposed in API responses, and deletable by the user at any time.

Source: \`packages/lib/src/encryption/encryption-utils.ts\`, \`packages/db/src/schema/ai.ts\` (\`user_ai_settings.encryptedApiKey\`).
`;

export default function ZeroTrustPage() {
  return <DocsMarkdown content={content} />;
}
