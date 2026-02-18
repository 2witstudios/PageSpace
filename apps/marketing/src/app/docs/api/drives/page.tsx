import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Drives API",
  description: "PageSpace drives API: workspace management, members, roles, page trees, trash, search, and AI agents.",
  path: "/docs/api/drives",
  keywords: ["API", "drives", "workspaces", "members", "roles", "search"],
});

const content = `
# Drives API

Workspace management, member management, page trees, search, and AI agents.

## Drive CRUD

### GET /api/drives

List all drives accessible to the current user (owned and shared).

**Response:**
\`\`\`json
[{
  "id": "string",
  "name": "string",
  "slug": "string",
  "ownerId": "string",
  "isOwner": true,
  "memberCount": 5,
  "pageCount": 23
}]
\`\`\`

---

### POST /api/drives

Create a new drive.

**Body:**
\`\`\`json
{ "name": "string" }
\`\`\`

---

### GET /api/drives/[driveId]

Get drive details with ownership and membership status.

---

### PATCH /api/drives/[driveId]

Update drive settings (name, AI preferences).

## Pages & Tree

### GET /api/drives/[driveId]/pages

Fetch all pages in a drive as a hierarchical tree.

---

### GET /api/drives/[driveId]/trash

List all trashed pages in a drive.

---

### POST /api/drives/[driveId]/restore

Restore a trashed drive.

## Members

### GET /api/drives/[driveId]/members

List drive members with roles.

**Response:**
\`\`\`json
[{
  "userId": "string",
  "name": "string",
  "email": "string",
  "role": "OWNER | ADMIN | MEMBER",
  "joinedAt": "string"
}]
\`\`\`

---

### POST /api/drives/[driveId]/members

Add a new member to the drive.

**Body:**
\`\`\`json
{ "userId": "string", "role": "ADMIN | MEMBER" }
\`\`\`

---

### DELETE /api/drives/[driveId]/members/[userId]

Remove a member from the drive. Requires drive ownership.

---

### POST /api/drives/[driveId]/members/invite

Send email invitation to join a drive.

**Body:**
\`\`\`json
{ "email": "string", "role": "ADMIN | MEMBER" }
\`\`\`

## Search

### GET /api/drives/[driveId]/search/regex

Search page content with regex patterns within a drive.

**Query params:** \`pattern\`, \`pageTypes\`, \`caseSensitive\`, \`maxResults\`

---

### GET /api/drives/[driveId]/search/glob

Search pages by title/path glob patterns within a drive.

**Query params:** \`pattern\`, \`pageTypes\`, \`maxResults\`

## AI Agents

### GET /api/drives/[driveId]/agents

List all AI agents in a drive.

---

### POST /api/drives/[driveId]/agents

Create a new AI agent in a drive.

## Permissions

### GET /api/drives/[driveId]/permissions-tree

Hierarchical view of all pages with permission status. Drive owner only.

**Query params:** \`userId\` (optional — view permissions for a specific user)
`;

export default function DrivesApiPage() {
  return <DocsMarkdown content={content} />;
}
