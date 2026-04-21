import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security",
  description: "PageSpace security overview: opaque session tokens, direct-permission RBAC, encrypted API keys, rate limiting, and tamper-evident audit logs.",
  path: "/docs/security",
  keywords: ["security", "authentication", "permissions", "encryption", "audit log"],
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
- **Rate limiting** — login, signup, and token refresh are rate-limited in Postgres via a weighted sliding window (see [Zero-Trust](/docs/security/zero-trust)).

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

- **Service-to-service auth** — internal services (web, realtime, processor) authenticate each other with opaque service tokens (\`ps_svc_*\`) issued by the web app, validated by the same \`sessionService\` that validates user sessions, and scoped to a specific resource and capability. No shared secrets.
- **Tamper-evident audit log** — security events are written to \`security_audit_log\` with a SHA-256 hash chain over the prior event, serialized by a Postgres advisory lock.
- **Distributed rate limiting** — Postgres-backed, works across multiple instances; fails closed in production.

## Known Tradeoffs

### Plaintext Page Content

Page content, conversation messages, and file metadata are stored as plaintext in PostgreSQL. This is a deliberate choice — it enables full-text search, regex tools, and AI features without the latency of searchable encryption. API keys and credentials are always encrypted at rest; page content is not encrypted at the application layer.

**Why**: PageSpace started as a local-first, self-hosted application where all data stays on your own hardware. Plaintext in your own Postgres instance enables powerful search and AI without the complexity of field-level encryption.

**Mitigations in place**:

- **Infrastructure encryption** — cloud deployments use volume-level encryption (e.g., AWS EBS, GCP persistent disk) so data is encrypted at rest at the storage layer, transparent to queries.
- **Access controls** — drive ownership, drive admin membership, and direct page permissions; every check hits the DB on every request.
- **Backup encryption** — rely on your infrastructure provider's backup encryption.
- **Audit logging** — SHA-256 hash-chain log covers authentication, authorization, data access, and admin events.
- **Network isolation** — realtime and processor run inside the Docker network; only web is exposed.

**Self-hosted deployments**: You control encryption at rest at the infrastructure level. PostgreSQL TDE or volume-level encryption protects stored content while preserving search and AI functionality. Data never leaves your deployment boundary.

**Cloud deployments**: On PageSpace Cloud, infrastructure-level encryption at rest is enabled. All data is stored in encrypted volumes and transmitted over TLS.

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
