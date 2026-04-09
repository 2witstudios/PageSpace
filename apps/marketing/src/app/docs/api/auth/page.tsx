import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Auth API",
  description: "PageSpace authentication API routes: OAuth, passkeys, magic links, session management, CSRF, and MCP token management.",
  path: "/docs/api/auth",
  keywords: ["API", "authentication", "OAuth", "passkeys", "magic links", "MCP tokens"],
});

const content = `
# Auth API

Authentication routes for passkeys, magic links, OAuth, session management, and MCP tokens.

## Core Authentication

### POST /api/auth/magic-link

Send a magic link to an email address for passwordless sign-in.

**Body:**
\`\`\`json
{ "email": "string" }
\`\`\`

**Response:** Success message. Sends email with one-time sign-in link.

**Security:** Rate limited by IP and email.

---

### POST /api/auth/logout

Log out and invalidate session.

**Side effects:** Deletes refresh token, clears cookies, logs event.

---

### GET /api/auth/me

Get the current authenticated user's profile.

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "role": "user | admin",
  "provider": "email | google | both",
  "currentAiProvider": "string",
  "currentAiModel": "string"
}
\`\`\`

---

### POST /api/auth/refresh

Refresh the session using a one-time refresh token. Implements token rotation.

**Security:** Rate limited. Detects token reuse (potential theft) and invalidates all sessions.

---

### GET /api/auth/csrf

Generate a CSRF token for the current session.

**Response:**
\`\`\`json
{ "csrfToken": "string" }
\`\`\`

## OAuth

### GET, POST /api/auth/google/signin

Initiate Google OAuth flow. POST accepts an optional \`returnUrl\`.

**Response:** Redirects to Google authorization URL.

---

### GET /api/auth/google/callback

Handle Google OAuth callback. Creates or links user account, sets authentication cookies.

## MCP Tokens

### POST /api/auth/mcp-tokens

Create a new MCP token for API access.

**Body:**
\`\`\`json
{ "name": "string" }
\`\`\`

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "token": "mcp_...",
  "createdAt": "string"
}
\`\`\`

The \`token\` value is only returned once at creation.

---

### GET /api/auth/mcp-tokens

List all MCP tokens for the current user (without token values).

**Response:**
\`\`\`json
[{
  "id": "string",
  "name": "string",
  "lastUsed": "string | null",
  "createdAt": "string",
  "revokedAt": "string | null"
}]
\`\`\`

---

### DELETE /api/auth/mcp-tokens/[tokenId]

Revoke a specific MCP token. The user must own the token.
`;

export default function AuthApiPage() {
  return <DocsMarkdown content={content} />;
}
