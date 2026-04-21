import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Drives API",
  description: "PageSpace drives API: workspace CRUD, members, roles, integrations, trash, search, agents, backups, and history.",
  path: "/docs/api/drives",
  keywords: ["API", "drives", "workspaces", "members", "roles", "integrations", "search"],
});

const content = `
# Drives API

A drive is a PageSpace workspace. Every page belongs to exactly one drive. This page covers drive CRUD, membership, roles, integrations, trash, search, and drive-level AI agents.

All routes accept session or MCP bearer auth unless noted. Write routes require \`x-csrf-token\` with session auth.

## Drive CRUD

### GET /api/drives

List drives accessible to the current user (owned + member).

**Query params:** \`includeTrash=true\` (include soft-deleted drives), \`tokenScopable=true\` (filter to drives usable as MCP token scopes).

---

### POST /api/drives

Create a new drive.

**Body:**
\`\`\`json
{ "name": "string" }
\`\`\`

The name \`Personal\` is reserved and rejected with 400. Scoped MCP tokens cannot create drives.

---

### GET /api/drives/[driveId]

Drive detail including ownership, membership, and settings.

---

### PATCH /api/drives/[driveId]

Update drive settings (name, AI preferences, slug, etc.).

---

### DELETE /api/drives/[driveId]

Move the drive to trash.

## Pages & tree

### GET /api/drives/[driveId]/pages

Return the drive's pages as a hierarchical tree.

---

### GET /api/drives/[driveId]/trash

List trashed pages in the drive.

---

### POST /api/drives/[driveId]/restore

Restore the drive from trash.

## Access tracking

### POST /api/drives/[driveId]/access

Record that the current user opened the drive (updates last-accessed time for the recents list).

## Members and invitations

### GET /api/drives/[driveId]/members

List drive members with their role assignments.

---

### POST /api/drives/[driveId]/members

Add an existing user as a member.

---

### GET /api/drives/[driveId]/members/[userId]

Fetch a single member's roles and metadata.

---

### PATCH /api/drives/[driveId]/members/[userId]

Update a member's role assignments.

---

### DELETE /api/drives/[driveId]/members/[userId]

Remove the member from the drive.

---

### POST /api/drives/[driveId]/members/invite

Email-invite a user to the drive.

**Body:**
\`\`\`json
{ "email": "string", "roleId": "string" }
\`\`\`

## Roles

Drives support custom roles with granular permission bundles.

### GET /api/drives/[driveId]/roles

List roles defined on the drive.

---

### POST /api/drives/[driveId]/roles

Create a new custom role.

---

### PATCH /api/drives/[driveId]/roles/reorder

Reorder roles (display order).

---

### GET /api/drives/[driveId]/roles/[roleId]

Fetch a role and its permissions.

---

### PATCH /api/drives/[driveId]/roles/[roleId]

Update a role's name, permissions, or color.

---

### DELETE /api/drives/[driveId]/roles/[roleId]

Delete a role.

## Task assignees

### GET /api/drives/[driveId]/assignees

Return the unified assignee list for task assignment — drive members and AI agents.

## Search

### GET /api/drives/[driveId]/search/regex

Regex search across page content in the drive.

**Query params:** \`pattern\`, \`pageTypes\`, \`caseSensitive\`, \`maxResults\`.

---

### GET /api/drives/[driveId]/search/glob

Title/path glob search.

**Query params:** \`pattern\`, \`pageTypes\`, \`maxResults\`.

## AI agents

### GET /api/drives/[driveId]/agents

List AI agents defined in the drive.

---

### POST /api/drives/[driveId]/agents

Create an agent (an \`AI_CHAT\` page with metadata).

## Permissions tree

### GET /api/drives/[driveId]/permissions-tree

Hierarchical view of pages with permission status. Drive owner only.

**Query params:** \`userId\` (optional — view the tree from that user's perspective).

## Integrations

OAuth-backed drive integrations (GitHub, calendars, Drive, etc.). See \`packages/lib/src/integrations/\` for provider implementations.

### GET /api/drives/[driveId]/integrations

List connections attached to the drive.

---

### POST /api/drives/[driveId]/integrations

Attach a new connection (requires an existing OAuth connection on the user's account).

---

### GET /api/drives/[driveId]/integrations/[connectionId]

Fetch a specific attached connection.

---

### DELETE /api/drives/[driveId]/integrations/[connectionId]

Detach a connection from the drive.

---

### GET /api/drives/[driveId]/integrations/audit

Audit trail of integration events for the drive.

---

### GET /api/drives/[driveId]/integrations/audit/export

Export the integration audit trail (CSV).

## Backups

### GET /api/drives/[driveId]/backups

List snapshot backups of the drive.

---

### POST /api/drives/[driveId]/backups

Trigger a new backup snapshot.

## History

### GET /api/drives/[driveId]/history

Drive-level activity feed.
`;

export default function DrivesApiPage() {
  return <DocsMarkdown content={content} />;
}
