import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Users API",
  description: "PageSpace users API: account, avatars, devices, data export, user search, and connections.",
  path: "/docs/api/users",
  keywords: ["API", "users", "account", "profile", "devices", "connections"],
});

const content = `
# Users API

Account management, user search, and connections between users.

## Account

### GET /api/account

Return the current user's core profile.

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "image": "string | null"
}
\`\`\`

Role and verification state live on \`/api/auth/me\`. The \`image\` field contains the current stored avatar URL when one is set; use \`/api/avatar/[userId]/[filename]\` for the canonical image path when serving an uploaded avatar.

---

### PATCH /api/account

Update the current user's name and email.

**Body:**
\`\`\`json
{ "name": "string", "email": "string" }
\`\`\`

Both fields are required. Email must be unique and is lowercased on save.

---

### DELETE /api/account

Permanently delete the account and anonymize the actor record.

### Avatars

| Route | Method | Purpose |
|---|---|---|
| \`/api/account/avatar\` | POST | Upload avatar (\`multipart/form-data\`) |
| \`/api/account/avatar\` | DELETE | Remove avatar |
| \`/api/avatar/[userId]/[filename]\` | GET | Serve an avatar image |

### Devices

### GET /api/account/devices

List the caller's registered devices (desktop + mobile sessions).

---

### DELETE /api/account/devices

Revoke one or more devices. Body:

\`\`\`json
{ "deviceIds": ["string"] }
\`\`\`

### Data export

### GET /api/account/export

Stream a ZIP archive containing the caller's personal data export (GDPR Article 15/20). Rate limited to 1 export per 24 hours.

### Verification status

### GET /api/account/verification-status

Return whether the caller's email is verified and any pending state.

### Drives status

### GET /api/account/drives-status

Return a lightweight rollup of the caller's drives (names, roles, last-accessed) for post-login routing.

### Claim drive

### POST /api/account/handle-drive

Claim or link an email-invited drive after sign-in.

## User search

### GET /api/users/search

Search users for mentions and collaboration.

**Query params:** \`q\` — matched against username, display name, and email.

Results respect privacy settings — only users who opted into discovery are returned.

---

### GET /api/users/find

Look up users by exact criteria. Used by admin and internal flows.

## Connections

A "connection" is a two-sided link between user accounts used for collaboration and suggestions.

### GET /api/connections

List the current user's connections.

---

### POST /api/connections

Create a connection with another user.

---

### GET /api/connections/search

Search for users you can connect with.

---

### PATCH /api/connections/[connectionId]

Update a connection's state (for example, accept a pending request).

---

### DELETE /api/connections/[connectionId]

Remove a connection.
`;

export default function UsersApiPage() {
  return <DocsMarkdown content={content} />;
}
