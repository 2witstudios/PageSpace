import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Security",
  description: "PageSpace security overview: opaque session tokens, RBAC permissions, encrypted API keys, rate limiting, and zero-trust architecture.",
  path: "/docs/security",
  keywords: ["security", "authentication", "permissions", "encryption", "zero trust"],
});

const content = `
# Security

PageSpace is designed with security as a foundational concern, not an afterthought. This section covers the authentication system, permission model, and zero-trust architecture.

## Security Posture

### Authentication

- **Opaque session tokens** — no JWT payloads to decode or forge
- **SHA-256 hash-only storage** — raw tokens are never stored in the database
- **Token rotation** — device tokens support automatic rotation with grace periods
- **Rate limiting** — login and refresh endpoints are rate-limited by IP and email
- **Token theft detection** — automatic session invalidation on refresh token reuse

### Authorization

- **Drive ownership** — drive owners have irrevocable full access to all pages
- **Direct page permissions** — boolean flags (canView, canEdit, canShare, canDelete) per user per page
- **Two-tier permission cache** — in-memory L1 + Redis L2 with 60s TTL
- **Cache bypass on mutations** — write operations always check fresh permissions

### Data Protection

- **Encrypted API keys** — AI provider keys are encrypted at rest
- **HTTP-only cookies** — session tokens are inaccessible to JavaScript
- **CSRF protection** — built-in CSRF token generation for state-changing requests
- **Content sanitization** — HTML content is sanitized to prevent XSS

### Infrastructure

- **Service-to-service auth** — internal services authenticate with shared secrets
- **Audit logging** — authentication events, permission changes, and AI operations are logged
- **Rate limiting** — sensitive endpoints have per-IP and per-user rate limits

## Known Tradeoffs

### Plaintext Page Content

Page content, conversation messages, and file metadata are stored as plaintext in PostgreSQL. This is a deliberate design decision — it enables full-text search and AI features like regex search across all user content. API keys and credentials are always encrypted at rest (AES-256-GCM), but page content is not encrypted at the application layer.

**Why**: PageSpace was originally designed as a local-first, self-hosted application where all data stays on your own hardware. Plaintext in your own PostgreSQL instance enables powerful search and AI capabilities without the latency and complexity of searchable encryption.

**Mitigations in place**:

- **Infrastructure encryption** — cloud deployments use volume-level encryption (e.g., AWS EBS, GCP persistent disk) so data is encrypted at rest at the storage layer, transparent to queries
- **Access controls** — RBAC permissions, opaque session tokens, and two-tier permission caching ensure only authorized users can access content
- **Backup encryption** — database backups should be encrypted using your infrastructure provider's backup encryption
- **Audit logging** — tamper-evident SHA-256 hash chain logs all authentication events, permission changes, and AI operations
- **Network isolation** — real-time collaboration and file processing run entirely within the local Docker network

**Self-hosted deployments**: If you run PageSpace on your own infrastructure, you control encryption at rest at the infrastructure level. PostgreSQL Transparent Data Encryption (TDE) or volume-level encryption protects stored content while preserving full search and AI functionality. Your data never leaves your deployment boundary.

**Cloud deployments**: On PageSpace Cloud, infrastructure-level encryption at rest is enabled by default. All data is stored in encrypted volumes and transmitted over TLS.

## Section Overview

### [Authentication](/docs/security/authentication)

How users authenticate with PageSpace: opaque session tokens, OAuth, passkeys, device tokens, and MCP tokens.

### [Permissions](/docs/security/permissions)

The RBAC permission model: drive ownership, direct page permissions, boolean flags, and the permission cache.

### [Zero-Trust Architecture](/docs/security/zero-trust)

The security architecture behind the scenes: token design, service-to-service auth, session management, and audit logging.
`;

export default function SecurityPage() {
  return <DocsMarkdown content={content} />;
}
