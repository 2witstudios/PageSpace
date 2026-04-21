import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Zero-Trust Architecture",
  description: "PageSpace zero-trust architecture: opaque session and service tokens, scoped service-to-service auth, continuously verified audit log, SSRF and path-traversal hardening, CSRF, and encrypted credentials.",
  path: "/docs/security/zero-trust",
  keywords: ["zero trust", "security architecture", "opaque tokens", "service tokens", "SSRF", "path traversal", "audit chain verification", "PKCE", "rate limiting"],
});

const content = `
# Zero-Trust Architecture

Every request is authenticated and authorized independently. Internal services validate the same kind of opaque token the browser sends, with scopes reduced to what the calling user actually has. Network location and prior hops grant no trust.

## Token Architecture

Every authentication token is a high-entropy opaque random string, hashed at rest, and validated by database lookup. Tokens carry no embedded claims — claims come from the database row. Revoking a token is a single-row delete that takes effect on the next request.

Every secret comparison — session verification, magic-link verification, device-token lookup, CSRF verification, auth-header checks — goes through a timing-safe helper. The presented value is hashed before comparison, so length, prefix structure, and content differences cannot leak through timing.

## Service-to-Service Authentication

Internal services — web, realtime, processor — authenticate each other with **opaque service tokens** validated by the same session service that validates user sessions. When one service calls another on behalf of a user, it requests a service token scoped to a specific resource (e.g., "write files on page X") and the token is minted only if the user actually has that permission. The service token carries the user's identity forward; downstream routes assert the exact scope they need.

### What this buys you

- **Instant revocation of cross-service capability.** Deleting the row disables the token in flight.
- **Least privilege.** A service token for page X with file-read scope cannot be replayed to write files or to access page Y.
- **Audit completeness.** Every service call is traceable to a specific user, resource, and scope in the audit log.
- **No shared secrets.** New services plug in by validating tokens against the database — there's no environment-variable secret to rotate or leak.

### Revocation Registry

Service tokens are tracked in a central revocation registry that fails closed: presenting a token whose identifier is unknown, expired, or explicitly revoked is rejected. A maintenance job prunes expired entries without losing the revocation semantic.

## Session Management

### Web Sessions

Web sessions are a single opaque token, stored only as a hash on the server and as an \`HttpOnly\`, \`Secure\`, \`SameSite=strict\` cookie on the browser. Sessions are validated on every request — cookie, lookup, expiry check, user-suspension check, optional idle-timeout check — and are revoked by deleting the row.

### Device Token Rotation

Device tokens — desktop and mobile clients — rotate on refresh. When the client presents its current token, the server issues a new one, keeps the old one valid for a brief grace window so concurrent requests don't fail, and marks the old one replaced. Rapid-refresh anomalies combined with user-agent or IP changes lower the device's trust score; a low enough score lets an operator force re-authentication.

### Global Invalidation

Administrative actions — log-out-everywhere, credential reset, account suspension — invalidate every active session for a user atomically. In-progress tokens are rejected on their next request.

## Rate Limiting

Login, signup, magic-link send, and token-refresh endpoints are rate-limited per-IP, per-email, and per-user depending on the endpoint, using a distributed sliding-window counter stored in Postgres. Exceeding a bucket returns HTTP 429 with \`Retry-After\`. Progressive blocking extends the ban for repeated violators. In production, a storage-layer failure fails closed rather than opening the floodgates.

## Audit Logging

Authentication, authorization, data-access, and admin events are recorded in a SHA-256 hash-chained log — every entry's hash incorporates the previous entry's hash, so any retroactive change to history is detectable. A database-level lock serializes chain writes so concurrent inserts cannot fork the chain.

### Tamper Detection

The chain is continuously re-verified:

- **Periodic full-chain sweep** — a scheduled job recomputes every entry's hash and checks every chain link. On break, a registered alert handler fires.
- **Preflight verification on delivery** — every batch bound for an external sink is re-verified synchronously before it's emitted. A detected break short-circuits the emission — the tampered batch never leaves the system.

Each audit entry carries the user reference (nullable for unauthenticated failures), IP, user agent, session reference, a resource reference where applicable, and a risk score for downstream alerting. Email addresses are redacted before write — enough structure is preserved for operational debugging without storing full PII.

## CSRF Protection

State-changing requests must present a CSRF token bound to the current session.

1. Client calls \`GET /api/auth/csrf\`.
2. Server validates the session cookie, then returns an HMAC-signed token that encodes the session reference.
3. Client includes the token in subsequent POST / PATCH / DELETE requests (header or body).
4. Server verifies the signature, confirms the token binds to the active session, and rejects mismatches.

## Outbound Request Safety (SSRF)

Every server-side URL fetch runs through a validator that resolves the hostname, then checks every resolved IP against a blocklist before connecting.

The blocklist covers:

- Loopback and localhost.
- Private network ranges and link-local addresses.
- Cloud provider metadata endpoints.
- Non-HTTP(S) schemes.

A single hostname can resolve to multiple IPs; the validator rejects the request if **any** resolved address is blocked — defeating DNS-rebinding tricks where a host advertises a public IP but serves a private one. IPv4-mapped IPv6 is normalized before comparison.

## Path Traversal Safety

Filesystem paths from uploads, avatars, and user-controlled input run through a validator before the filesystem is touched.

Blocked:

- Directory traversal.
- Encoded, double-encoded, and further-nested-encoded variants.
- Null-byte injection.
- Symlink escape — paths are resolved through the filesystem and rejected if the resolved target falls outside the configured base directory.
- Absolute paths when a base directory is configured.

## Content Security

### HTML Sanitization

User-generated HTML is sanitized before render. Canvas pages render inside Shadow DOM, isolating arbitrary author styles and scripts from the rest of the app. Mentions and links are validated server-side before rendering.

### API Key Encryption

AI provider API keys are encrypted at rest with AES-256-GCM using scrypt-derived keys, a unique salt per write, and a unique IV per encryption. Keys are decrypted only on the request path that makes the provider call, are never returned in API responses, and are deletable by the user at any time.
`;

export default function ZeroTrustPage() {
  return <DocsMarkdown content={content} />;
}
