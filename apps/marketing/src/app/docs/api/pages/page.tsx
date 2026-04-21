import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Pages API",
  description: "PageSpace pages API: CRUD, hierarchy, permissions, bulk operations, agent config, export, history, tasks, and file processing.",
  path: "/docs/api/pages",
  keywords: ["API", "pages", "CRUD", "permissions", "bulk operations", "agent config", "export"],
});

const content = `
# Pages API

CRUD operations on pages, along with hierarchy, permissions, bulk moves, agent configuration, exports, version history, tasks, and file processing.

All routes accept session or MCP bearer auth unless noted. State-changing routes require \`x-csrf-token\` when called with a session cookie.

## Page CRUD

### POST /api/pages

Create a new page.

**Body:**
\`\`\`json
{
  "driveId": "string",
  "title": "string",
  "type": "DOCUMENT | FOLDER | CHANNEL | AI_CHAT | CANVAS | FILE | SHEET | TASK_LIST | CODE",
  "parentId": "string | null",
  "content": "string",
  "contentMode": "html | markdown",
  "systemPrompt": "string",
  "enabledTools": ["string"],
  "aiProvider": "string",
  "aiModel": "string"
}
\`\`\`

\`driveId\`, \`title\`, and \`type\` are required; the rest are optional. \`type\` must be a creatable page type (exported by \`getCreatablePageTypes()\`). \`TERMINAL\` is experimental and rejected here.

**Auth:** Drive member with create permission. MCP-scoped tokens can only create pages in their allowed drives. Returns \`201\` with the new page on success.

---

### GET /api/pages/[pageId]

Fetch a page and its immediate metadata.

---

### PATCH /api/pages/[pageId]

Update a page. Accepts any subset of the creation fields (e.g. \`title\`, \`content\`). Synchronizes mention records when content changes.

---

### DELETE /api/pages/[pageId]

Move the page (and its children) to trash. Soft delete — restore via \`POST /api/pages/[pageId]/restore\`.

## Tree and hierarchy

### POST /api/pages/tree

Return the full page tree for a drive.

**Body:**
\`\`\`json
{ "driveId": "string" }
\`\`\`

---

### GET /api/pages/[pageId]/breadcrumbs

Breadcrumb trail from drive root to the page.

---

### GET /api/pages/[pageId]/children

Direct children of the page.

---

### PATCH /api/pages/reorder

Move a page or change its sibling order. Validates against circular references.

**Body:**
\`\`\`json
{
  "pageId": "string",
  "newParentId": "string | null",
  "newPosition": 0
}
\`\`\`

## Permissions

### GET /api/pages/[pageId]/permissions

List permissions on the page (drive owner and per-user grants).

---

### POST /api/pages/[pageId]/permissions

Grant or update a user's permissions.

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

**Auth:** Drive owner or user with \`canShare\`.

---

### DELETE /api/pages/[pageId]/permissions

Revoke a user's permissions.

**Body:**
\`\`\`json
{ "userId": "string" }
\`\`\`

---

### GET /api/pages/[pageId]/permissions/check

Return the caller's effective permissions on the page.

**Response:**
\`\`\`json
{ "canView": true, "canEdit": true, "canShare": false, "canDelete": false }
\`\`\`

## Bulk operations

Bulk routes live at \`/api/pages/bulk-*\` (hyphen, not \`/bulk/*\`). Each is a single POST or DELETE against a list of page IDs.

### POST /api/pages/bulk-copy

Copy pages (optionally with their descendants) into a target drive/parent.

**Body:**
\`\`\`json
{
  "pageIds": ["string"],
  "targetDriveId": "string",
  "targetParentId": "string | null",
  "includeChildren": true
}
\`\`\`

---

### POST /api/pages/bulk-move

Move pages into a new drive/parent atomically.

**Body:**
\`\`\`json
{
  "pageIds": ["string"],
  "targetDriveId": "string",
  "targetParentId": "string | null"
}
\`\`\`

---

### DELETE /api/pages/bulk-delete

Trash multiple pages in one call.

**Body:**
\`\`\`json
{
  "pageIds": ["string"],
  "trashChildren": true
}
\`\`\`

## Agent configuration

### GET /api/pages/[pageId]/agent-config

Get the AI agent configuration for an \`AI_CHAT\` page (system prompt, enabled/available tools, provider, model).

---

### PATCH /api/pages/[pageId]/agent-config

Update the agent configuration. Any subset of \`{systemPrompt, enabledTools, aiProvider, aiModel}\`.

## Exports

Each export route streams the page content as the named format.

| Route | Method | Content-Type |
|---|---|---|
| \`/api/pages/[pageId]/export/markdown\` | GET | \`text/markdown\` |
| \`/api/pages/[pageId]/export/docx\` | GET | DOCX |
| \`/api/pages/[pageId]/export/csv\` | GET | CSV (sheet pages) |
| \`/api/pages/[pageId]/export/xlsx\` | GET | XLSX (sheet pages) |

## Version history

### GET /api/pages/[pageId]/history

List stored versions for the page.

---

### GET /api/pages/[pageId]/versions/compare

Diff two versions. See the route handler for the supported query params.

## Tasks (task-list pages)

### GET /api/pages/[pageId]/tasks

List tasks on a \`TASK_LIST\` page.

---

### POST /api/pages/[pageId]/tasks

Create a task on a \`TASK_LIST\` page.

## Content modes

### POST /api/pages/[pageId]/convert-content-mode

Convert a \`DOCUMENT\` page's content between rich-text (\`html\`) and \`markdown\`.

## AI usage

### GET /api/pages/[pageId]/ai-usage

Aggregated AI usage for conversations tied to the page.

## Views

### POST /api/pages/[pageId]/view

Record a page view event (used for recents and read-state tracking).

## File processing

### GET /api/pages/[pageId]/processing-status

Processing state for a \`FILE\` page.

---

### POST /api/pages/[pageId]/reprocess

Requeue a file for text extraction, OCR, or image optimization.

## Trash

### POST /api/pages/[pageId]/restore

Restore a trashed page (and its descendants) to its last known parent.
`;

export default function PagesApiPage() {
  return <DocsMarkdown content={content} />;
}
