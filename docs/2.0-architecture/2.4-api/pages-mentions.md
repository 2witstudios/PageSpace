# Page & Mention Routes

### GET /api/mentions/search

**Purpose:** Searches for pages and users to be used in mentions, with support for cross-drive search.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `q`: string (query parameter - search query)
- `driveId`: string (query parameter - required for within-drive search, optional for cross-drive)
- `crossDrive`: boolean (query parameter - set to 'true' for cross-drive search)
- `types`: string (comma-separated list of 'page', 'user' - defaults to both if not specified)
**Response Schema:** Array of `MentionSuggestion` objects with id, label, type, data, and description.
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 404 (Drive Not Found), 500 (Internal Server Error)
**Implementation Notes:**
- Cross-drive search finds all accessible drives (owned or member of)
- Page results include all page types (DOCUMENT, FOLDER, CHANNEL, AI_CHAT, SHEET) under 'page' mention type
- User results only include users who have access to the searched drives
- Results are filtered by user permissions and sorted by relevance
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### POST /api/pages

**Purpose:** Creates a new page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `title`: string
- `type`: "DOCUMENT" | "FOLDER" | "CHANNEL" | "AI_CHAT" | "CANVAS" | "SHEET"
- `parentId`: string | null
- `driveId`: string
- `content`: any (optional)
**Response Schema:** Newly created page object with optional AI chat details.
**Implementation Notes:**
- For AI_CHAT pages, inherits user's current AI provider settings
- Automatically calculates position based on parent's existing children
- Broadcasts page creation event via Socket.IO
- Tracks operation in activity log
**Status Codes:** 201 (Created), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/pages/[pageId]

**Purpose:** Fetches details for a specific page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Page object with nested details.
**Implementation Notes:**
- Uses Next.js 15 async params pattern (params are Promises)
- Checks user permissions via canUserViewPage
- Tracks page view in activity log
**Status Codes:** 200 (OK), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### PATCH /api/pages/[pageId]

**Purpose:** Updates a page's title or content.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
- `title`: string (optional)
- `content`: any (optional - sanitized for empty content)
**Response Schema:** Updated page object with nested details.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Sanitizes empty TipTap content (empty paragraphs, default JSON structure)
- Extracts and manages page mentions for backlinking
- Broadcasts page update event via Socket.IO
- Tracks operation in activity log
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### DELETE /api/pages/[pageId]

**Purpose:** Moves a page (and optionally its children) to trash.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
- `trash_children`: boolean (optional)
**Response Schema:** Message object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Checks user permissions via canUserDeletePage
- Recursively trashes child pages if requested
- Broadcasts page deletion event via Socket.IO
- Tracks operation in activity log
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### GET /api/pages/[pageId]/breadcrumbs

**Purpose:** Fetches the breadcrumbs (ancestor path) for a given page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Array of breadcrumb page objects.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Returns ancestor path from root to current page
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### GET /api/pages/[pageId]/children

**Purpose:** Fetches the direct children pages of a given page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Array of child page objects.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Returns only non-trashed children
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### GET /api/pages/[pageId]/permissions

**Purpose:** Fetches all permissions for a specific page, including owner and enriched subject details.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Object containing owner and permissions array.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Enriches permissions with subject details (user/group names)
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### GET /api/pages/[pageId]/permissions/check

**Purpose:** Checks if a user has a specific permission on a page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
- `action`: string (query parameter - 'VIEW', 'EDIT', 'SHARE', or 'DELETE')
**Response Schema:** Object with `hasPermission: boolean`
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Utilizes permission checking functions from @pagespace/lib/server
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### POST /api/pages/[pageId]/permissions

**Purpose:** Creates a new permission for a page.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
- `subjectId`: string
- `subjectType`: "USER" | "GROUP"
- `action`: "VIEW" | "EDIT" | "SHARE" | "DELETE"
**Response Schema:** Newly created permission object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Checks user has SHARE permission before allowing new permissions
**Status Codes:** 201 (Created), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### DELETE /api/pages/[pageId]/permissions/[permissionId]

**Purpose:** Revokes a specific permission from a page (route not found in current implementation).
**Note:** This route appears to have been removed or is not implemented in the current codebase.
**Alternative:** Permission management may be handled through other endpoints.
**Last Updated:** 2025-08-21

### POST /api/pages/[pageId]/restore

**Purpose:** Restores a trashed page (and its trashed children) from the trash.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Message object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Recursively restores trashed children
- Broadcasts page restoration event via Socket.IO
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### PATCH /api/pages/reorder

**Purpose:** Reorders a page by changing its parent and/or position.
**Auth Required:** Yes (supports both cookie and MCP Bearer token authentication)
**Request Schema:**
- `pageId`: string
- `newParentId`: string | null
- `newPosition`: number
**Response Schema:** Message object.
**Implementation Notes:**
- Adjusts positions of sibling pages
- Validates new parent permissions
- Broadcasts reorder event via Socket.IO
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/pages/search

**Purpose:** Searches for pages by title within a specific drive (route not found in current implementation).
**Note:** This route appears to have been removed or is not implemented in the current codebase.
**Alternative:** Use `/api/mentions/search` with `types=page` parameter for page search functionality.
**Last Updated:** 2025-08-21

---

## Mentions Table

**Purpose:** The `mentions` table stores relationships between pages where one page mentions another. This is used for backlinking and contextual navigation.
**Location:** `packages/db/src/schema/core.ts`
**Schema:**
```typescript
export const mentions = pgTable('mentions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    sourcePageId: text('sourcePageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    targetPageId: text('targetPageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
});
```
**Indexes:**
- `mentions_source_page_id_target_page_id_key`: Compound index on source and target
- `mentions_source_page_id_idx`: Index on source page
- `mentions_target_page_id_idx`: Index on target page
**Relations:**
- `sourcePage`: The page containing the mention
- `targetPage`: The page being mentioned
**Last Updated:** 2025-08-21

## Mention Formats

**AI Assistant & Chat**: The AI assistant and chat interfaces use a typed markdown format to ensure the correct context is fetched for mentions.
- **Format:** `@[label](id:type)`
- **Example:** `@[My Document](123:page)`

When a mention is used, the system will fetch the content of the mentioned page and inject it into the AI's context. The content that is fetched depends on the type of page:
- **DOCUMENT**: The content of the page.
- **SHEET**: Evaluated grid snapshot (first 50 rows × 26 columns) and raw cell inputs for formulas.
- **AI_CHAT**: The last 10 messages from the chat.
- **CHANNEL**: The last 10 messages from the channel.
- **FOLDER**: A list of the files in the folder.

**MentionSuggestion Type:**
```typescript
interface MentionSuggestion {
  id: string;
  label: string;
  type: 'page' | 'user';
  data: {
    pageType?: 'DOCUMENT' | 'FOLDER' | 'CHANNEL' | 'AI_CHAT' | 'SHEET';
    driveId?: string;
  };
  description?: string;
}
```
