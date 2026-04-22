import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Authentication",
  description: "PageSpace authentication: opaque session tokens, magic links, OAuth 2.1 with PKCE on Google and Apple, passkeys with conditional UI, device tokens, MCP tokens, account lockout, and the auth API.",
  path: "/docs/security/authentication",
  keywords: ["authentication", "session tokens", "OAuth", "PKCE", "passkeys", "magic links", "MCP tokens", "account lockout", "WebAuthn"],
});

const content = `
# Authentication

PageSpace uses opaque session tokens for every authenticated flow. A session is one high-entropy token; revocation is a single-row delete that takes effect on the next request. There is no access/refresh pair on web sessions, and tokens carry no embedded claims — claims live in the database alongside the session.

## Token Types

| Token | Lifetime | Use |
|-------|----------|-----|
| Session | 7 days (configurable) | Browser session |
| Service | Short-lived, issued per call | Service-to-service, scoped to a specific resource |
| Device | Long-lived, rotates on refresh | Desktop / mobile persistent auth |
| MCP | No automatic expiry; explicit revocation | External MCP clients (Claude Desktop, Cursor, etc.) |
| Magic link | Short-lived, single-use | Email login |

All tokens are **stored only as hashes**. The raw value is returned to the client once at creation and never persisted server-side. Every secret comparison uses a timing-safe helper: the presented value is hashed before comparison, so length, prefix structure, or content differences cannot leak through timing.

Session cookies are \`HttpOnly\`, \`Secure\` in production, and \`SameSite=strict\` by default.

## Authentication Providers

PageSpace is passwordless. There is no password column on the user record. Accounts sign in through one of the flows below.

### Magic Links

Passwordless email login. The server generates a single-use token, emails a signed URL, and issues a session when the link is opened. The verification path uses a timing-safe comparison.

- \`POST /api/auth/magic-link/send\` — email a login link
- \`GET  /api/auth/magic-link/verify\` — redirect endpoint; verifies the token, creates a session, sets the cookie

### Google OAuth

- \`GET | POST /api/auth/google/signin\` — start the flow
- \`GET /api/auth/google/callback\` — OAuth callback; links existing accounts by verified email or creates a new one
- \`POST /api/auth/google/native\` — native (mobile) ID-token exchange
- \`POST /api/auth/google/one-tap\` — Google One Tap credential exchange

### Apple OAuth

- \`POST /api/auth/apple/signin\` — start the Sign in with Apple flow
- \`POST /api/auth/apple/callback\` — Apple form-post callback
- \`POST /api/auth/apple/native\` — native (iOS) identity-token exchange

### OAuth PKCE

The Google sign-in flow uses OAuth 2.1 with RFC 7636 Proof Key for Code Exchange. The server generates a \`code_verifier\` and \`code_challenge\` (S256) at signin; the callback consumes the verifier to complete the token exchange. An intercepted authorization code alone is useless without the verifier. Sign in with Apple doesn't expose a PKCE parameter, so it's not covered by this path — it relies on ID-token signature validation instead. If the PKCE store is unreachable at verification time the exchange fails open; rare, but worth knowing.

### Passkeys (WebAuthn)

Hardware-backed authentication. Supports Touch ID, Face ID, Windows Hello, and cross-device passkeys. Conditional UI (browser autofill) is supported — the browser can surface saved passkeys before the user types an email.

- \`GET /api/auth/passkey\` — list the current user's passkeys
- \`POST /api/auth/passkey/register/options\` + \`/register\` — registration challenge and verification
- \`POST /api/auth/passkey/authenticate/options\` + \`/authenticate\` — login challenge and verification
- \`DELETE /api/auth/passkey/{id}\` — revoke a passkey

## Session Management

### Device Token Rotation

Device tokens (desktop, iOS, Android) rotate on refresh. When the client presents its current token, the server issues a new one, marks the old one replaced, and keeps the old one valid through a short grace window so in-flight requests don't fail.

Web sessions do not rotate — they're single opaque tokens revoked by row delete.

### Global Invalidation

Administrative actions — "log out everywhere", credential reset, account suspension — invalidate every active session for a user atomically. In-progress tokens are rejected on their next request.

### Idle Timeout

An optional idle timeout can be enabled per deployment to expire sessions after a configurable idle window. Recommended for deployments with stricter compliance requirements.

### Rate Limiting

Login, signup, magic-link send, and token refresh are rate-limited per-IP, per-email, and per-user depending on the endpoint, using a distributed sliding-window counter stored in Postgres. In production, rate-limit storage failures fail closed.

### Account Lockout

Rate limiting throttles traffic; account lockout targets the account under attack. After repeated failed authentication attempts against a single account, the account is temporarily locked regardless of attempt source. Because lockout state is durable:

- it persists across infrastructure restarts,
- it's unaffected by an attacker cycling IP addresses,
- failed attempts across every auth method feed the same counter.

A successful authentication clears the counter. Every failed attempt and every lock transition is recorded in the tamper-evident audit log.

## MCP Tokens

MCP tokens let external tools (Claude Desktop, Cursor, custom MCP clients) call the PageSpace API on behalf of a user.

- Created via **Settings > MCP** or \`POST /api/auth/mcp-tokens\`.
- Named for identification.
- Optionally scoped to specific drives. If scoped and all of the scoped drives are later deleted, the token denies all access (fail-closed).
- No automatic expiration; explicit \`DELETE /api/auth/mcp-tokens/{id}\` to revoke.
- The raw token value is returned once at creation; only the hash is stored.

Clients authenticate by sending \`Authorization: Bearer mcp_...\`.

## Device Token Theft Detection

Device tokens carry a trust score and a suspicious-activity counter. On each use, the server compares the incoming request against the device's stored fingerprint — changes to browser or OS family, unexpected IP region, and refresh-timing anomalies all lower the trust score. Applications can gate sensitive operations on the score, and operators can force re-authentication on a device by revoking its token.

## Activity Logging

Authentication and authorization events — login success and failure, logout, session and token lifecycle, device registration and revocation, rate-limit hits, brute-force detection, and other anomalies — are written to a SHA-256 hash-chained audit log. Each entry captures user agent, IP, session reference, and a risk score for downstream alerting. See [Zero-Trust](/docs/security/zero-trust#audit-logging) for how the chain is continuously verified.

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
