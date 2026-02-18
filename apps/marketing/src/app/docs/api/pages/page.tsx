import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Pages API",
  description: "PageSpace pages API: CRUD operations, hierarchy, permissions, bulk operations, agent configuration, and file processing.",
  path: "/docs/api/pages",
  keywords: ["API", "pages", "CRUD", "permissions", "bulk operations", "agent config"],
});

const content = `
# Pages API

CRUD operations for pages, hierarchy management, permissions, bulk operations, and agent configuration.

## Page CRUD

### POST /api/pages

Create a new page.

**Body:**
\`\`\`json
{
  "driveId": "string",
  "title": "string",
  "type": "DOCUMENT | FOLDER | AI_CHAT | CHANNEL | CANVAS | FILE | SHEET | TASK_LIST | CODE",
  "parentId": "string (optional)",
  "content": "string (optional)"
}
\`\`\`

**Auth:** User must be drive owner or admin.

---

### GET /api/pages/[pageId]

Fetch a page with children and messages.

**Response:**
\`\`\`json
{
  "id": "string",
  "title": "string",
  "type": "string",
  "content": "string",
  "driveId": "string",
  "parentId": "string | null",
  "children": [],
  "createdAt": "string",
  "updatedAt": "string"
}
\`\`\`

---

### PATCH /api/pages/[pageId]

Update page title or content. Synchronizes mentions on content updates.

**Body:**
\`\`\`json
{
  "title": "string (optional)",
  "content": "string (optional)"
}
\`\`\`

---

### DELETE /api/pages/[pageId]

Move a page to trash (soft delete).

## Hierarchy

### GET /api/pages/[pageId]/breadcrumbs

Returns breadcrumb navigation path from drive root to current page.

---

### GET /api/pages/[pageId]/children

Lists direct child pages with basic metadata.

---

### POST /api/pages/reorder

Update page position for drag-and-drop reordering.

**Body:**
\`\`\`json
{
  "pageId": "string",
  "parentId": "string | null",
  "position": "number"
}
\`\`\`

## Permissions

### GET /api/pages/[pageId]/permissions

List all permissions for a page. Returns drive owner info and user permissions.

---

### POST /api/pages/[pageId]/permissions

Grant or update permissions.

**Body:**
\`\`\`json
{
  "userId": "string",
  "canView": true,
  "canEdit": true,
  "canShare": false,
  "canDelete": false
}
\`\`\`

**Auth:** User must be drive owner or have \`canShare\` permission.

---

### DELETE /api/pages/[pageId]/permissions

Revoke a user's permissions on a page.

**Body:**
\`\`\`json
{ "userId": "string" }
\`\`\`

---

### GET /api/pages/[pageId]/permissions/check

Check the current user's permissions on a page.

**Response:**
\`\`\`json
{ "canView": true, "canEdit": true, "canShare": false, "canDelete": false }
\`\`\`

## Agent Config

### GET /api/pages/[pageId]/agent-config

Get agent configuration for an AI_CHAT page.

**Response:**
\`\`\`json
{
  "systemPrompt": "string",
  "enabledTools": ["string"],
  "availableTools": ["string"],
  "aiProvider": "string",
  "aiModel": "string"
}
\`\`\`

---

### PATCH /api/pages/[pageId]/agent-config

Update agent configuration.

**Body:**
\`\`\`json
{
  "systemPrompt": "string (optional)",
  "enabledTools": ["string"] ,
  "aiProvider": "string (optional)",
  "aiModel": "string (optional)"
}
\`\`\`

## Bulk Operations

### POST /api/pages/bulk/create-structure

Create multiple pages atomically in a folder structure.

---

### POST /api/pages/bulk/delete

Delete multiple pages in a single operation.

---

### POST /api/pages/bulk/move

Move multiple pages to a new parent or drive.

---

### POST /api/pages/bulk/rename

Rename multiple pages using pattern matching.

---

### POST /api/pages/bulk/update-content

Update content in multiple pages simultaneously.

## File Processing

### GET /api/pages/[pageId]/processing-status

Get file processing status for FILE type pages.

---

### POST /api/pages/[pageId]/reprocess

Requeue a file for processing.

---

### POST /api/pages/[pageId]/restore

Restore a trashed page to its original location.
`;

export default function PagesApiPage() {
  return <DocsMarkdown content={content} />;
}
