import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Zero-Trust Architecture",
  description: "PageSpace zero-trust security: opaque tokens, service-to-service auth, session management, audit logging, and rate limiting.",
  path: "/docs/security/zero-trust",
  keywords: ["zero trust", "security architecture", "opaque tokens", "audit logging", "rate limiting"],
});

const content = `
# Zero-Trust Architecture

PageSpace implements a zero-trust security model where every request is authenticated and authorized independently. No request is trusted based on network location or prior authentication alone.

## Token Architecture

### Why Opaque Tokens

PageSpace migrated from JWTs to opaque session tokens for several security advantages:

| Concern | JWT | Opaque Token |
|---------|-----|-------------|
| Payload exposure | Token contains user data | Token is a random string |
| Revocation | Requires blocklist or short expiry | Instant — delete from database |
| Token size | Large (1KB+) | Small (~60 bytes) |
| Validation | Cryptographic signature check | Hash lookup in database |
| Stolen token | Valid until expiry | Revocable immediately |

### Token Format

\`\`\`
ps_sess_<32 bytes of randomness, base64url encoded>
\`\`\`

- **Prefix**: Identifies token type (\`ps_sess_\`, \`ps_dev_\`, \`ps_sock_\`, \`ps_unsub_\`)
- **Entropy**: 32 bytes (256 bits) of cryptographic randomness
- **Storage**: Only the SHA-256 hash is stored in the database
- **Comparison**: Constant-time comparison prevents timing attacks

## Service-to-Service Authentication

Internal services (web, realtime, processor) authenticate with each other using shared secrets:

\`\`\`
Web App ←→ Realtime Service (Socket.IO)
Web App ←→ Processor Service (File Processing)
\`\`\`

- Shared secrets are configured via environment variables
- Internal API calls include the secret in request headers
- Services validate the secret before processing requests
- No user tokens are passed between services — only the shared secret and user context

## Session Management

### Session Lifecycle

1. **Login**: Generate opaque token → hash → store hash in DB → set HTTP-only cookie
2. **Request**: Read cookie → hash → look up in DB → validate expiration → authorize
3. **Refresh**: Validate refresh token → issue new session → rotate refresh token
4. **Logout**: Delete session from DB → clear cookies

### Global Invalidation

The \`tokenVersion\` field enables instant invalidation of all sessions:

\`\`\`
Password change → Increment tokenVersion → All existing sessions invalid
"Logout all devices" → Increment tokenVersion → All sessions invalid
\`\`\`

Every token validation checks the user's \`tokenVersion\`. If the stored version doesn't match, the session is rejected.

## Rate Limiting

### Endpoint Protection

| Endpoint | Strategy | Purpose |
|----------|----------|---------|
| Login | Per-IP + per-email | Prevent brute force |
| Signup | Per-IP | Prevent mass account creation |
| Token refresh | Per-user | Prevent token abuse |
| API routes | Per-user | Prevent API abuse |

### Implementation

Rate limits use a sliding window algorithm. Exceeding the limit returns HTTP 429 with a \`Retry-After\` header. Successful authentication resets the counter.

## Audit Logging

### What's Logged

| Event | Data Captured |
|-------|--------------|
| Login attempt | Email, IP, user agent, success/failure |
| Signup | Email, IP, provider (email/Google) |
| Password change | User ID, IP |
| Token refresh | User ID, device, IP |
| Permission change | Granter, grantee, page, flags |
| MCP token usage | Token ID, operation, timestamp |
| AI tool execution | User, tool name, page context, success |

### Security Alerts

- **Token reuse detected**: Potential token theft — all sessions invalidated
- **Rate limit exceeded**: Potential brute force — logged with IP
- **Permission cache invalidation failure**: Stale permissions may persist for up to 60s

## CSRF Protection

State-changing requests require a CSRF token:

1. Client requests token: \`GET /api/auth/csrf\`
2. Server generates token bound to the session
3. Client includes token in subsequent POST/PATCH/DELETE requests
4. Server validates token before processing

## Content Security

### HTML Sanitization

User-generated HTML content is sanitized to prevent XSS:
- Canvas pages use Shadow DOM isolation
- Document content is rendered through controlled components
- Mentions and links are validated before rendering

### API Key Encryption

AI provider API keys are encrypted at rest in the database. Keys are:
- Encrypted on write with server-side encryption
- Decrypted only when making provider API calls
- Never exposed in API responses
- Deletable by the user at any time
`;

export default function ZeroTrustPage() {
  return <DocsMarkdown content={content} />;
}
