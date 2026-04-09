import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Users API",
  description: "PageSpace users API: account management, user search, connections, and profile updates.",
  path: "/docs/api/users",
  keywords: ["API", "users", "account", "profile", "connections"],
});

const content = `
# Users API

Account management, user search, and connections.

## Account

### GET /api/account

Get the current user's profile.

**Response:**
\`\`\`json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "image": "string | null",
  "provider": "email | google | both",
  "role": "user | admin"
}
\`\`\`

---

### PATCH /api/account

Update name and email with validation.

**Body:**
\`\`\`json
{
  "name": "string (optional)",
  "email": "string (optional)"
}
\`\`\`

---

### POST /api/account/avatar

Upload a new avatar image.

**Content-Type:** \`multipart/form-data\`

## User Search

### GET /api/users/search

Search users for mentions and collaboration.

**Query params:** \`q\` (searches username, display name, email)

Results respect privacy controls — only users who have opted into discovery are returned.

---

### GET /api/users/find

Find users by specific criteria. Used for administrative functions.

## Connections

### GET /api/connections

List the current user's connections.

---

### POST /api/connections

Create a new connection with another user.

---

### GET /api/connections/search

Search for users to connect with.

---

### DELETE /api/connections/[connectionId]

Remove a connection.
`;

export default function UsersApiPage() {
  return <DocsMarkdown content={content} />;
}
