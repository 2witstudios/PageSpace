import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Auth API",
  description: "PageSpace authentication API: passkeys, magic links, Google and Apple OAuth, sessions, CSRF, device and realtime tokens, and MCP tokens.",
  path: "/docs/api/auth",
  keywords: ["API", "authentication", "passkeys", "magic links", "OAuth", "MCP tokens"],
});

const content = `
# Auth API

PageSpace uses passwordless authentication: **passkeys (WebAuthn)** or **magic links** for primary sign-in, with **Google** and **Apple** OAuth as alternative flows. Sessions are opaque 32-byte tokens stored in an httpOnly \`session\` cookie; only the SHA-256 hash is persisted.

## CSRF

### GET /api/auth/csrf

Issue a CSRF token bound to the current session. Required for any state-changing request with session auth.

**Response:**
\`\`\`json
{ "csrfToken": "string" }
\`\`\`

Send the token in the \`x-csrf-token\` header on POST/PATCH/DELETE. Bearer (\`Authorization: Bearer mcp_...\`) calls skip CSRF.

---

### GET /api/auth/login-csrf

Issue a CSRF token for the unauthenticated login flow. Returns the token value and sets a \`login_csrf\` cookie. Used by magic-link send.

## Magic link

### POST /api/auth/magic-link/send

Send a magic link email for passwordless sign-in.

**Headers:** \`x-login-csrf-token\` matching the \`login_csrf\` cookie (from \`GET /api/auth/login-csrf\`).

**Body:**
\`\`\`json
{
  "email": "string",
  "platform": "web | desktop",
  "deviceId": "string (required when platform=desktop)",
  "deviceName": "string (required when platform=desktop)"
}
\`\`\`

**Security:** Rate limited per IP and email.

---

### GET /api/auth/magic-link/verify?token=...

Consume a magic link. On success, issues a session cookie and redirects. Desktop-scoped links return an exchange code for \`/api/auth/desktop/exchange\`.

## Passkeys (WebAuthn)

Passkey flows use two steps: fetch a challenge from \`.../options\`, then submit the signed attestation or assertion.

### Registration (existing user)

| Route | Purpose |
|---|---|
| \`POST /api/auth/passkey/register/options\` | Generate registration challenge |
| \`POST /api/auth/passkey/register\` | Verify attestation, store credential |
| \`POST /api/auth/passkey/register/handoff\` | Hand off a pending registration between devices |

### Authentication

| Route | Purpose |
|---|---|
| \`POST /api/auth/passkey/authenticate/options\` | Generate authentication challenge |
| \`POST /api/auth/passkey/authenticate\` | Verify assertion, issue session |

### Signup with passkey (new account)

| Route | Purpose |
|---|---|
| \`POST /api/auth/signup-passkey/options\` | Registration challenge for new account |
| \`POST /api/auth/signup-passkey\` | Create account and passkey atomically |

### Passkey management

| Route | Method | Purpose |
|---|---|---|
| \`/api/auth/passkey\` | GET | List current user's passkeys |
| \`/api/auth/passkey/[passkeyId]\` | PATCH | Rename a passkey (\`{ "name": "string" }\`) |
| \`/api/auth/passkey/[passkeyId]\` | DELETE | Delete a passkey |

Management routes require a valid session + \`x-csrf-token\`.

## OAuth

### Google

| Route | Method | Purpose |
|---|---|---|
| \`/api/auth/google/signin\` | GET, POST | Start OAuth redirect. POST accepts \`{ "returnUrl": "string" }\`. |
| \`/api/auth/google/callback\` | GET | OAuth callback. Creates or links the account and sets the session cookie. |
| \`/api/auth/google/native\` | POST | Exchange a native Google ID token (mobile). |
| \`/api/auth/google/one-tap\` | POST | Exchange a Google One Tap credential on the web. |
| \`/api/auth/mobile/oauth/google/exchange\` | POST | Mobile-app Google token exchange. |

### Apple

| Route | Method | Purpose |
|---|---|---|
| \`/api/auth/apple/signin\` | GET, POST | Start Apple OAuth redirect. |
| \`/api/auth/apple/callback\` | POST | Apple OAuth form-post callback. |
| \`/api/auth/apple/native\` | POST | Exchange a native Apple identity token (mobile). |

## Email verification

### GET /api/auth/verify-email?token=...

Consume an email-verification token. Redirects with a status query param.

---

### POST /api/auth/resend-verification

Resend the verification email for the currently authenticated user.

## Session

### GET /api/auth/me

Return the current authenticated user.

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "image": "string | null",
  "role": "user | admin",
  "emailVerified": "string | null"
}
\`\`\`

---

### POST /api/auth/logout

Revoke the current session. Clears the \`session\` cookie and emits audit events.

## Desktop and mobile

### POST /api/auth/desktop/exchange

Exchange a one-time OAuth code (from the \`pagespace://auth-exchange?code=...\` deep link) for tokens.

**Body:**
\`\`\`json
{ "code": "string" }
\`\`\`

**Response:**
\`\`\`json
{
  "sessionToken": "string",
  "csrfToken": "string",
  "deviceToken": "string"
}
\`\`\`

Codes are short-lived and one-time use. The session cookie is also set on the response.

---

### POST /api/auth/device/register

Register a long-lived device token for a desktop or mobile client.

### POST /api/auth/device/refresh

Rotate a device token. Desktop and mobile clients use this instead of a web session.

### POST /api/auth/mobile/refresh

Mobile-app variant of device-token refresh.

## Realtime tokens

### GET /api/auth/socket-token

Issue a short-lived token for Socket.IO authentication. Required because the realtime service is cross-origin and cannot receive the SameSite=Strict session cookie.

**Response:**
\`\`\`json
{ "token": "ps_sock_...", "expiresAt": "string" }
\`\`\`

---

### POST /api/auth/ws-token

Issue a long-lived WebSocket token for desktop/mobile persistent connections. Rate limited per user.

**Response:**
\`\`\`json
{ "token": "string" }
\`\`\`

## MCP tokens

MCP tokens authenticate programmatic access from external tools (Claude Desktop, Cursor, \`pagespace-mcp\`). Tokens are prefixed \`mcp_\` and only the SHA-256 hash is stored.

### POST /api/auth/mcp-tokens

Create a new MCP token.

**Body:**
\`\`\`json
{
  "name": "string",
  "driveIds": ["string"]
}
\`\`\`

\`driveIds\` is optional. When present and non-empty, the token is scoped to those drives and cannot create new drives. The user must own or be a member of every drive in the list.

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "token": "mcp_...",
  "createdAt": "string",
  "lastUsed": null,
  "driveScopes": [{ "id": "string", "name": "string" }]
}
\`\`\`

The raw \`token\` value is returned once and never persisted.

---

### GET /api/auth/mcp-tokens

List the current user's non-revoked MCP tokens.

**Response:**
\`\`\`json
[{
  "id": "string",
  "name": "string",
  "lastUsed": "string | null",
  "createdAt": "string",
  "isScoped": true,
  "driveScopes": [{ "id": "string", "name": "string" }]
}]
\`\`\`

---

### DELETE /api/auth/mcp-tokens/[tokenId]

Revoke the specified MCP token. The caller must own the token.
`;

export default function AuthApiPage() {
  return <DocsMarkdown content={content} />;
}
