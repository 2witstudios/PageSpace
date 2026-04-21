import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Authentication",
  description: "PageSpace authentication: opaque session tokens, magic links (5-minute), OAuth 2.1 PKCE on Google and Apple, passkeys with conditional UI, device tokens, MCP tokens, account lockout, and the full auth API.",
  path: "/docs/security/authentication",
  keywords: ["authentication", "session tokens", "OAuth", "PKCE", "passkeys", "magic links", "MCP tokens", "account lockout", "WebAuthn"],
});

const content = `
# Authentication

PageSpace uses opaque session tokens for every authenticated flow. There is no access/refresh pair on web sessions. A session is one token; revocation is a row delete.

Source: \`packages/lib/src/auth/session-service.ts\`, \`packages/lib/src/auth/opaque-tokens.ts\`, \`apps/web/src/app/api/auth/**\`.

## Token Types

| Token | Prefix | Generator | Entropy | Lifetime | Use |
|-------|--------|-----------|---------|----------|-----|
| Session | \`ps_sess_\` | \`generateOpaqueToken('sess')\` | 256 bits | 7 days (configurable) | Browser session |
| Service | \`ps_svc_\` | \`generateOpaqueToken('svc')\` | 256 bits | 5 minutes default, 30 days max | Service-to-service |
| Device | \`ps_dev_\` | \`generateOpaqueToken('dev')\` | 256 bits | Long-lived, rotates on refresh | Desktop / mobile persistent auth |
| MCP | \`mcp_\` | \`generateToken('mcp')\` | 256 bits | No expiry; revoked explicitly | External MCP clients |
| Socket | \`ps_sock_\` | Route-local \`randomBytes(24)\` | 192 bits | 5 minutes | Cross-origin Socket.IO handshake |
| Magic link | \`ps_magic_\` | \`generateToken('ps_magic')\` | 256 bits | 5 minutes, single-use | Email login link |
| Unsubscribe | \`ps_unsub_\` | Route-local \`randomBytes(24)\` | 192 bits | 365 days, single-use | One-click email unsubscribe |

All tokens are opaque — they carry no embedded claims. The prefix is for logs and debugging; validation is a hash lookup.

## How Tokens Work

1. **Generate** — random bytes, base64url-encoded, prefixed with the token type.
2. **Hash** — SHA-256 the raw token.
3. **Store** — only the hash is written to the database, plus a 12-char prefix for log correlation.
4. **Return** — the raw token is returned to the client once; the server never sees it again.
5. **Validate** — on each request, the server hashes the presented token and looks up the hash.

\`\`\`
User login → Generate random bytes → Prefix + base64url encode → SHA-256 hash
                                                                     ↓
                                                              Insert row: hash + prefix
                                                                     ↓
Client keeps raw token (as HTTP-only cookie for web) → Subsequent request hashes cookie
                                                                     ↓
                                                              Server looks up hash → validates
\`\`\`

Session cookies are set \`HttpOnly\`, \`Secure\` in production, and \`SameSite=strict\` by default. The value becomes \`SameSite=lax\` only in production when \`COOKIE_DOMAIN\` is configured for multi-subdomain deployments.

Source: \`apps/web/src/lib/auth/cookie-config.ts\`.

## Authentication Providers

PageSpace is passwordless. There is no password column on the user record. Accounts are created and re-authenticated through one of the flows below.

### Magic Links

Passwordless email login. The server generates a single-use token (5-minute TTL), emails a signed URL, and issues a session when the link is opened. The verify endpoint compares the presented token via timing-safe comparison before creating the session.

- \`POST /api/auth/magic-link/send\` — email a login link
- \`GET  /api/auth/magic-link/verify\` — redirect endpoint; verifies the token, creates a session, sets the cookie

Source: \`packages/lib/src/auth/magic-link-service.ts\` (\`MAGIC_LINK_EXPIRY_MINUTES = 5\`).

### Google OAuth

- \`GET | POST /api/auth/google/signin\` — start the flow (GET initiates, POST is used by client-side callers)
- \`GET /api/auth/google/callback\` — OAuth callback; links existing accounts by verified email or creates a new one
- \`POST /api/auth/google/native\` — native (mobile) ID-token exchange
- \`POST /api/auth/google/one-tap\` — Google One Tap credential exchange

### Apple OAuth

- \`POST /api/auth/apple/signin\` — start the Sign in with Apple flow
- \`POST /api/auth/apple/callback\` — Apple form-post callback
- \`POST /api/auth/apple/native\` — native (iOS) identity-token exchange

### OAuth PKCE

Both Google and Apple flows use RFC 7636 (Proof Key for Code Exchange). On \`signin\`, the server generates a \`code_verifier\` + \`code_challenge\` (S256) and stores the verifier in \`auth_handoff_tokens\` (\`kind='pkce'\`) with a 10-minute TTL. The callback retrieves and consumes the verifier to complete the token exchange — an intercepted authorization code alone is useless.

Source: \`packages/lib/src/auth/pkce.ts\`.

### Passkeys (WebAuthn)

Hardware-backed authentication. Supports Touch ID, Face ID, Windows Hello, and cross-device passkeys. Conditional UI (browser autofill) is supported — the challenge is issued against a fixed system user so the browser can surface saved passkeys without the user typing an email first.

- \`GET /api/auth/passkey\` — list the current user's passkeys
- \`POST /api/auth/passkey/register/options\` + \`/register\` — registration challenge and verification
- \`POST /api/auth/passkey/authenticate/options\` + \`/authenticate\` — login challenge and verification
- \`DELETE /api/auth/passkey/{id}\` — revoke a passkey

**Operational limits** (\`packages/lib/src/auth/passkey-service.ts\` \`PASSKEY_CONFIG\`):

| Limit | Value |
|---|---|
| Passkeys per user | 10 |
| WebAuthn timeout | 60 s |
| Challenge TTL | 5 minutes |
| Max passkey name length | 255 chars |

## Session Management

### Device Token Rotation

Device tokens (desktop, iOS, Android) rotate on refresh. Web sessions do not.

1. Client presents the current device token to \`POST /api/auth/device/refresh\` or \`POST /api/auth/mobile/refresh\`.
2. Server validates, issues a new token, and marks the old one replaced.
3. A short grace window lets in-flight requests with the old token complete before it becomes invalid.

Source: \`packages/lib/src/auth/device-auth-utils.ts\` (\`rotateDeviceToken\`).

### Global Invalidation

Every \`users\` row has a \`tokenVersion\` counter. Every session stores the \`tokenVersion\` it was created with. On validation, \`sessionService\` rejects any session whose stored version doesn't match the user's current version.

Bumping \`tokenVersion\` invalidates every outstanding session for that user atomically. "Log out everywhere", password/passkey reset flows, and administrative suspension all use this.

Source: \`packages/lib/src/auth/session-service.ts\`.

### Idle Timeout

If \`SESSION_IDLE_TIMEOUT_MS\` is set, sessions are revoked on validation once \`now - lastUsedAt\` exceeds the configured window. Unset by default. HIPAA-style deployments should enable this.

Source: \`packages/lib/src/auth/constants.ts\`.

### Rate Limiting

| Endpoint | Scope |
|----------|-------|
| Login | Per-IP + per-email |
| Signup | Per-IP |
| Device / mobile token refresh | Per-user |
| Magic-link send | Per-email + per-IP |

Rate limiting is backed by Postgres (\`rate_limit_buckets\`) using a weighted sliding-window algorithm. In production, rate-limit storage failures fail closed and return \`Retry-After\`.

Source: \`packages/lib/src/security/distributed-rate-limit.ts\`.

### Account Lockout

Rate limiting throttles traffic; account lockout targets the account under attack. After **10 consecutive failed authentication attempts** against a single account, the account is locked for **15 minutes**, regardless of attempt source. State is kept on the \`users\` row (\`failedLoginAttempts\`, \`lockedUntil\`) so:

- the lock persists across server restarts,
- the lock is unaffected by an attacker cycling IPs,
- failed attempts across all auth methods feed the same counter.

A successful authentication resets the counter. Every failed attempt and every lock transition is recorded in \`security_audit_log\`.

Source: \`packages/lib/src/auth/account-lockout.ts\` (\`MAX_FAILED_ATTEMPTS = 10\`, \`LOCKOUT_DURATION_MS = 15 * 60 * 1000\`).

## MCP Tokens

MCP tokens let external tools (Claude Desktop, Cursor, custom MCP clients) call the PageSpace API on a user's behalf.

- Created via **Settings > MCP** or \`POST /api/auth/mcp-tokens\`
- Named for identification
- Optionally scoped to specific drives (\`isScoped=true\` + \`mcp_token_drives\` rows); if scoped and all scoped drives are deleted, the token denies all access (fail-closed)
- No automatic expiration; explicit \`DELETE /api/auth/mcp-tokens/{id}\` to revoke
- The raw token value is returned once at creation. Only the hash is stored.

Clients authenticate by sending \`Authorization: Bearer mcp_...\`.

Source: \`apps/web/src/app/api/auth/mcp-tokens/route.ts\`, \`packages/db/src/schema/auth.ts\` (\`mcp_tokens\`, \`mcp_token_drives\`).

## Device Token Theft Detection

Device tokens carry a \`trustScore\` (starts at 1.0) and a \`suspiciousActivityCount\`. On each use, the server compares the incoming request against the stored fingerprint:

| Signal | Trust-score penalty |
|--------|---------------------|
| User-agent browser/OS family mismatch | −0.20 |
| IP address change (outside same /24) | −0.05 |
| Location change | −0.10 |
| Rapid refresh (within 60s of last use) | −0.15 |

The score is clamped to [0, 1]. Applications can gate sensitive operations on the score, and an operator can force re-auth on a device by revoking its token. Global invalidation of all user sessions is a separate mechanism (bump \`tokenVersion\`).

Source: \`packages/lib/src/auth/device-fingerprint-utils.ts\`.

## Activity Logging

Authentication and authorization events are written to \`security_audit_log\` with a SHA-256 hash chain. Events you'll see in this domain:

| Event type | Fired on |
|------------|----------|
| \`auth.login.success\` / \`auth.login.failure\` | Login attempts |
| \`auth.logout\` | Explicit logout |
| \`auth.session.created\` / \`auth.session.revoked\` | Session lifecycle |
| \`auth.token.created\` / \`auth.token.revoked\` / \`auth.token.refreshed\` | Token issuance and device-token rotation |
| \`auth.device.registered\` / \`auth.device.revoked\` | Device registration / removal |
| \`security.rate.limited\` / \`security.brute.force.detected\` | Rate-limit hits and brute-force detection |
| \`security.suspicious.activity\` / \`security.anomaly.detected\` | Device fingerprint anomalies and other signals |

Each entry captures user agent, IP, session ID where applicable, and a risk score. See [Zero-Trust](/docs/security/zero-trust#audit-logging) for the hash chain details.

Source: \`packages/db/src/schema/security-audit.ts\`, \`packages/lib/src/audit/security-audit.ts\`.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| POST | \`/api/auth/magic-link/send\` | Email a magic-link login |
| GET | \`/api/auth/magic-link/verify\` | Verify link, issue session |
| POST | \`/api/auth/logout\` | Revoke current session |
| GET | \`/api/auth/me\` | Current user profile |
| GET | \`/api/auth/csrf\` | Issue a session-bound CSRF token |
| GET \\| POST | \`/api/auth/google/signin\` | Start Google OAuth |
| GET | \`/api/auth/google/callback\` | Google OAuth callback |
| POST | \`/api/auth/google/native\` | Native Google ID-token exchange |
| POST | \`/api/auth/apple/signin\` | Start Apple OAuth |
| POST | \`/api/auth/apple/callback\` | Apple OAuth callback |
| POST | \`/api/auth/apple/native\` | Native Apple identity-token exchange |
| GET | \`/api/auth/passkey\` | List passkeys |
| POST | \`/api/auth/passkey/register/options\` | WebAuthn registration challenge |
| POST | \`/api/auth/passkey/register\` | Verify registration response |
| POST | \`/api/auth/passkey/authenticate/options\` | WebAuthn login challenge |
| POST | \`/api/auth/passkey/authenticate\` | Verify login response |
| DELETE | \`/api/auth/passkey/{id}\` | Revoke passkey |
| POST | \`/api/auth/device/register\` | Register a device |
| POST | \`/api/auth/device/refresh\` | Rotate a device token |
| POST | \`/api/auth/mobile/refresh\` | Rotate a mobile device token |
| POST | \`/api/auth/mobile/oauth/google\` | Mobile Google OAuth handoff |
| GET | \`/api/auth/socket-token\` | Short-lived Socket.IO token |
| GET \\| POST | \`/api/auth/mcp-tokens\` | List or create MCP tokens |
| DELETE | \`/api/auth/mcp-tokens/{id}\` | Revoke an MCP token |
`;

export default function AuthenticationPage() {
  return <DocsMarkdown content={content} />;
}
