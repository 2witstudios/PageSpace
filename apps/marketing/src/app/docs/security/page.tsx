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
- **Global invalidation** — administrative actions (log-out-everywhere, credential reset, suspension) reject every existing session for a user atomically.
- **Device-token theft detection** — device (desktop/mobile) tokens rotate; anomalous signals (user-agent change, unexpected IP, refresh-timing anomalies) lower a per-device trust score that operators can gate sensitive actions on.
- **Account lockout** — accounts facing repeated failed authentication are temporarily locked, regardless of source IP. Lockout state is durable across infrastructure restarts and complements rate limiting: rate limits throttle traffic, lockout halts the targeted account.
- **OAuth 2.1 PKCE (Google)** — the Google sign-in flow uses RFC 7636 with a server-stored \`code_verifier\`. An intercepted authorization code is unusable without it. Sign in with Apple doesn't expose PKCE and relies on its ID-token signature validation instead.
- **Timing-safe comparisons** — every secret comparison (magic-link verify, device-token lookup, auth headers, CSRF) goes through a SHA-256 pre-hash + \`timingSafeEqual\`, so length and prefix structure leak no timing.
- **Rate limiting** — login, signup, magic-link send, and token refresh are rate-limited in Postgres via a weighted sliding window (see [Zero-Trust](/docs/security/zero-trust#rate-limiting)).

### Authorization

- **Drive ownership** — \`drives.ownerId\` grants unconditional full access to every page in the drive.
- **Drive admin membership** — drive members with admin role, once they accept the invitation, get full access to every page in the drive.
- **Direct page permissions** — per-user capability flags on each page (view, edit, share, delete), with optional expiry for temporary grants.
- **No inheritance** — permissions do not flow from parent pages. Each page is checked independently.
- **Fresh checks** — every permission lookup queries Postgres directly. There is no cache layer.

### Data Protection

- **Encrypted API keys** — AI provider keys are encrypted at rest with AES-256-GCM (scrypt KDF, unique salt+IV per write).
- **HTTP-only cookies** — session cookies are inaccessible to JavaScript.
- **SameSite cookies** — \`strict\` by default; relaxed to \`lax\` only for multi-subdomain deployments.
- **CSRF tokens** — HMAC-signed, bound to the session, required on state-changing requests.
- **Content sanitization** — user HTML is sanitized before render; canvas pages render in Shadow DOM.

### Infrastructure

- **Service-to-service auth** — internal services authenticate each other with scoped, revocable tokens that are validated the same way user sessions are. Every cross-service call carries a user context — least privilege is enforced per call, not per service.
- **Revocation registry** — service tokens have a central revocation registry that fails closed on unknown or expired identifiers.
- **Continuously verified audit log** — security events are recorded with a SHA-256 hash chain over the prior event, serialized at write time. The chain is re-verified on a schedule and, separately, re-verified for every batch before it's emitted to external sinks — a detected break stops the emission.
- **SSRF protection** — server-side URL fetches are validated against a blocklist covering loopback, private network ranges, link-local addresses, cloud metadata endpoints, and non-HTTP schemes. Every DNS-resolved address is checked, not just the first, which defeats DNS-rebinding tricks.
- **Path-traversal protection** — file paths from uploads and user input are validated to reject directory traversal, encoded variants, null-byte injection, and symlink escape.
- **Distributed rate limiting** — Postgres-backed, works across multiple instances; fails closed in production.

## How content is stored

Page content, conversation messages, and file metadata live in PostgreSQL, encrypted at rest via volume-level encryption and delivered over TLS in transit. Content is stored queryable so full-text search, regex tools, and AI agents can operate on it directly — the alternative (searchable-encryption schemes or decrypt-on-every-query) trades significant latency and capability for protection the volume layer already provides.

Secrets are a different story: API keys, OAuth tokens, and stored credentials are encrypted at the application layer with a key PageSpace holds, so losing a disk or leaking a DB dump doesn't leak them.

**What protects page content**:

- **Encryption at rest** — data sits on volume-encrypted disks. Backups inherit the same encryption.
- **TLS in transit** — every request between browser, web app, realtime service, and processor is encrypted.
- **Access controls** — drive ownership, drive admin membership, and per-page permissions; every check hits the DB on every request.
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
