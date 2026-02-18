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
