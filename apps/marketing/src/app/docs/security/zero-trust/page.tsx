import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Zero-Trust Architecture",
  description: "PageSpace zero-trust security: opaque session tokens, opaque service tokens for service-to-service auth, session lifecycle, rate limiting, and tamper-evident audit logs.",
  path: "/docs/security/zero-trust",
  keywords: ["zero trust", "security architecture", "opaque tokens", "service tokens", "audit logging", "rate limiting"],
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
- Compared in constant time inside \`crypto.createHash(...)\` or database index lookups — no string-compare timing exposure.

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

Each entry carries user ID (nullable for unauthenticated failures), IP, user agent, session ID, a resource reference where applicable, and a \`riskScore\` for downstream alerting.

## CSRF Protection

State-changing requests must present a CSRF token bound to the current session.

1. Client calls \`GET /api/auth/csrf\`.
2. Server validates the session cookie, then returns an HMAC-signed token that encodes the session ID.
3. Client includes the token in subsequent POST/PATCH/DELETE requests (header or body).
4. Server verifies the signature, checks the token binds to the active session, and rejects mismatches.

Source: \`packages/lib/src/auth/csrf-utils.ts\`, \`apps/web/src/app/api/auth/csrf/route.ts\`.

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
