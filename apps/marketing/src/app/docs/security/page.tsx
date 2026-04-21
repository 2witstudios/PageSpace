import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security",
  description: "PageSpace security overview: opaque session tokens, direct-permission RBAC, account lockout, OAuth PKCE, encrypted API keys, rate limiting, continuously verified audit logs, SSRF and path-traversal hardening.",
  path: "/docs/security",
  keywords: ["security", "authentication", "permissions", "encryption", "audit log", "account lockout", "PKCE", "SSRF", "path traversal", "HMAC cron"],
});

const content = `
# Security

This section documents PageSpace's authentication system, permission model, and operational controls. Read it the way an ops or security reviewer would: every claim here is backed by a specific file in the repo.

## Security Posture

### Authentication

- **Opaque session tokens** — random 256-bit values with no embedded claims, validated by database lookup.
- **SHA-256 hash-only storage** — raw tokens are returned to the client once; only the hash is stored.
- **Instant revocation** — deleting the session row immediately invalidates the token on the next request.
- **Global invalidation** — bumping \`users.tokenVersion\` rejects every existing session on validation.
- **Device-token theft detection** — device (desktop/mobile) tokens rotate; mismatched user agent, IP change, or rapid refresh lowers a per-device \`trustScore\`.
- **Account lockout** — 10 consecutive failed attempts lock the account for 15 minutes. DB-backed, so it persists across restarts and survives attacker IP rotation. Complements rate limiting — rate limits throttle traffic, lockout halts the targeted account.
- **OAuth 2.1 PKCE** — Google and Apple flows use RFC 7636 with a server-stored \`code_verifier\`. An intercepted authorization code is unusable without it.
- **Timing-safe comparisons** — every secret comparison (magic-link verify, device-token lookup, auth headers, CSRF) goes through a SHA-256 pre-hash + \`timingSafeEqual\`, so length and prefix structure leak no timing.
- **Rate limiting** — login, signup, magic-link send, and token refresh are rate-limited in Postgres via a weighted sliding window (see [Zero-Trust](/docs/security/zero-trust#rate-limiting)).

### Authorization

- **Drive ownership** — \`drives.ownerId\` grants unconditional full access to every page in the drive.
- **Drive admin membership** — a \`drive_members\` row with \`role='ADMIN'\` and \`acceptedAt IS NOT NULL\` grants full access.
- **Direct page permissions** — per-user boolean flags (\`canView\`, \`canEdit\`, \`canShare\`, \`canDelete\`) on \`page_permissions\`, with optional \`expiresAt\` for temporary grants.
- **No inheritance** — permissions do not flow from parent pages. Each page is checked independently.
- **Fresh checks** — every permission lookup queries Postgres directly. There is no cache layer.

### Data Protection

- **Encrypted API keys** — AI provider keys are encrypted at rest with AES-256-GCM (scrypt KDF, unique salt+IV per write).
- **HTTP-only cookies** — session cookies are inaccessible to JavaScript.
- **SameSite cookies** — \`strict\` by default; relaxed to \`lax\` only when \`COOKIE_DOMAIN\` is configured for subdomain sharing.
- **CSRF tokens** — HMAC-signed, bound to the session ID, required on state-changing requests.
- **Content sanitization** — user HTML is sanitized before render; canvas pages render in Shadow DOM.

### Infrastructure

- **Service-to-service auth** — internal services (web, realtime, processor) authenticate each other with opaque service tokens (\`ps_svc_*\`) issued by the web app, validated by the same \`sessionService\` that validates user sessions, and scoped to a specific resource and capability.
- **JTI revocation** — every service token's JTI is tracked in \`revoked_service_tokens\`; unknown or expired JTIs fail closed.
- **Continuously verified audit log** — security events are written to \`security_audit_log\` with a SHA-256 hash chain over the prior event, serialized by a Postgres advisory lock. A cron route re-verifies the chain on a schedule, and the SIEM delivery worker re-verifies each batch synchronously before emitting it — a detected break stops the emission.
- **SSRF protection** — outbound URL fetches run through a validator that blocks localhost, RFC1918 private ranges, link-local addresses, and cloud metadata endpoints (AWS, GCP, Azure, Alibaba — including IPv6 variants), and verifies every DNS-resolved IP, not just the first.
- **Path-traversal protection** — file paths from uploads and avatars run through a validator that blocks \`../\`, URL-encoded and double-encoded variants, null bytes, and symlink escape via \`realpath\`.
- **HMAC-signed cron endpoints** — internal cron routes require HMAC-SHA256 headers (timestamp, nonce, signature). In production, missing \`CRON_SECRET\` fails closed.
- **Distributed rate limiting** — Postgres-backed, works across multiple instances; fails closed in production.

## Known Tradeoffs

### Plaintext Page Content

Page content, conversation messages, and file metadata are stored as plaintext in PostgreSQL. This is a deliberate choice — it enables full-text search, regex tools, and AI features without the latency of searchable encryption. API keys and credentials are always encrypted at rest; page content is not encrypted at the application layer.

**Mitigations in place**:

- **Infrastructure encryption** — data is stored on volume-encrypted disks and transmitted over TLS.
- **Access controls** — drive ownership, drive admin membership, and direct page permissions; every check hits the DB on every request.
- **Backup encryption** — backups inherit the same volume-level encryption.
- **Audit logging** — SHA-256 hash-chain log covers authentication, authorization, data access, and admin events.
- **Network isolation** — realtime and processor run on an internal network; only the web app is reachable from the public edge.

## Section Overview

### [Authentication](/docs/security/authentication)

Token types, providers (magic links, Google, Apple, passkeys), session management, and the full auth API surface.

### [Permissions](/docs/security/permissions)

How access is resolved: drive ownership, drive admin membership, direct page permissions, expiring grants, and optional per-drive role templates.

### [Zero-Trust Architecture](/docs/security/zero-trust)

Token design, service-to-service authentication, session lifecycle, rate limiting, and the hash-chained audit log.
`;

export default function SecurityPage() {
  return <DocsMarkdown content={content} />;
}
