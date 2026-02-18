import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Authentication",
  description: "PageSpace authentication system: opaque session tokens, OAuth, device tokens, MCP tokens, rate limiting, and token security.",
  path: "/docs/security/authentication",
  keywords: ["authentication", "session tokens", "OAuth", "passkeys", "MCP tokens"],
});

const content = `
# Authentication

PageSpace uses a **custom opaque session-based authentication system** with multiple providers and token types.

## Token Types

| Token | Prefix | Lifetime | Use Case |
|-------|--------|----------|----------|
| Session | \`ps_sess_\` | Configurable | Web authentication |
| Device | \`ps_dev_\` | Long-lived | Desktop/mobile persistent auth |
| Socket | \`ps_sock_\` | 5 minutes | WebSocket authentication |
| Email Unsubscribe | \`ps_unsub_\` | One-time use | Email unsubscribe links |
| MCP | \`mcp_\` | No expiration | API access for external tools |

All tokens are opaque — they contain no embedded data. They're random strings with type prefixes for debugging.

## How Tokens Work

1. **Generation**: 32 bytes of cryptographic randomness, base64url-encoded with a type prefix
2. **Storage**: Only the SHA-256 hash is stored in the database. The raw token is never stored.
3. **Validation**: On each request, the token is hashed and looked up in the database
4. **Delivery**: Session tokens are set as HTTP-only, secure, SameSite cookies

\`\`\`
User login → Generate random token → Hash with SHA-256 → Store hash in DB
                ↓
            Set HTTP-only cookie with raw token
                ↓
Subsequent request → Hash cookie value → Look up hash in DB → Validate
\`\`\`

## Authentication Providers

### Email/Password

Standard email/password authentication with:
- **bcryptjs** hashing (10 salt rounds)
- Email verification
- Rate-limited login attempts

### Google OAuth

OAuth 2.0 flow with Google:
- Initiate via \`POST /api/auth/google/signin\`
- Callback at \`GET /api/auth/google/callback\`
- Automatic account creation or linking for existing accounts
- Profile sync (name, avatar)

### Passkeys (WebAuthn)

Hardware-backed authentication using passkeys:
- Passwordless login
- Biometric authentication (Touch ID, Face ID, Windows Hello)
- Cross-device authentication

## Session Management

### Token Rotation

Device tokens support automatic rotation:
1. Client presents a device token
2. Server validates and issues a new token
3. Old token enters a grace period for concurrent request handling
4. After the grace period, the old token is invalidated

### Version Control

The \`tokenVersion\` field on the user record enables global session invalidation:
- Changing your password increments \`tokenVersion\`
- All existing sessions are invalidated
- "Log out all devices" increments \`tokenVersion\`

### Rate Limiting

| Endpoint | Limit | Scope |
|----------|-------|-------|
| Login | Configurable | Per IP + per email |
| Token refresh | Configurable | Per user |
| Signup | Configurable | Per IP |

Rate limits reset on successful authentication.

## MCP Tokens

MCP tokens are long-lived API tokens for external tool access:

1. Created via **Settings > MCP** or \`POST /api/auth/mcp-tokens\`
2. Named for identification (e.g., "Claude Desktop", "Cursor")
3. Optionally scoped to specific drives
4. Revocable at any time
5. Token value is shown once at creation — only the hash is stored

MCP tokens authenticate API requests via the \`Authorization: Bearer mcp_...\` header.

## Security Features

### Token Theft Detection

If a refresh token is reused (indicating potential theft):
1. The reused token is invalidated
2. All sessions for that user are invalidated
3. The event is logged for security analysis

### Secure Cookie Configuration

\`\`\`
HttpOnly: true      — Not accessible to JavaScript
Secure: true        — Only sent over HTTPS
SameSite: Lax       — CSRF protection
Domain: configured  — Scoped to your domain
Path: /             — Available site-wide
\`\`\`

### Activity Logging

All authentication events are logged:
- Login attempts (success and failure)
- Signup events
- Token refresh
- Logout
- Password changes
- OAuth connections
- MCP token creation/revocation

Logs include device information, IP address, and user agent for audit trails.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| POST | \`/api/auth/signup\` | Register with email/password |
| POST | \`/api/auth/login\` | Authenticate with email/password |
| POST | \`/api/auth/logout\` | Invalidate session |
| GET | \`/api/auth/me\` | Get current user |
| POST | \`/api/auth/refresh\` | Refresh access token |
| GET | \`/api/auth/csrf\` | Get CSRF token |
| GET/POST | \`/api/auth/google/signin\` | Initiate Google OAuth |
| GET | \`/api/auth/google/callback\` | Handle OAuth callback |
| GET/POST | \`/api/auth/mcp-tokens\` | List/create MCP tokens |
| DELETE | \`/api/auth/mcp-tokens/[id]\` | Revoke MCP token |
`;

export default function AuthenticationPage() {
  return <DocsMarkdown content={content} />;
}
