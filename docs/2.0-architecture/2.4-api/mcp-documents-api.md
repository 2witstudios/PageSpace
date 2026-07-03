# MCP Documents API

**Route:** `apps/web/src/app/api/mcp/documents/route.ts`

## Overview

`POST /api/mcp/documents` is the single HTTP endpoint external MCP clients use
to read and edit page content — including **sheet cell editing**, which has no
more discoverable home despite the route name suggesting plain-text documents
only. One handler is multiplexed by an `operation` field in the JSON body:

```ts
z.enum(['read', 'replace', 'insert', 'delete', 'edit-cells'])
```

This is the HTTP surface used by external MCP clients (e.g. the
`pagespace-mcp` npm package) authenticating with a Bearer token. PageSpace's
own in-app chat agent does **not** call this route — it uses the equivalent
in-process AI SDK tools (`replace_lines`, `edit_sheet_cells`, etc. in
`apps/web/src/lib/ai/tools/page-write-tools.ts`) with the same validation
rules but a different (richer) response shape and different auth
(`canActorEditPage`, not a bearer token). If you're documenting or debugging
AI-driven edits from inside a PageSpace chat, look there instead.

## Authentication

`authenticateMCPRequest(req)` (`apps/web/src/lib/auth/index.ts`) requires:

```
Authorization: Bearer mcp_<token>
```

Session cookies are rejected — this route is MCP-token-only.

Two authorization checks run before any operation executes:

1. **Drive scope.** If the token is drive-scoped (has `allowedDriveIds`), the
   target page's `driveId` must be in that list, or the request fails with:
   ```json
   { "error": "This token does not have access to this drive" }
   ```
   `403 Forbidden`.
2. **Page-level access.** `getPrincipalAccessLevel(auth, pageId)` must return
   `canView: true`, or the request fails with a plain `403 Forbidden` body.
   Mutating operations (`replace`, `insert`, `delete`, `edit-cells`)
   additionally require `canEdit: true`, or:
   ```json
   {
     "error": "Write permission required",
     "details": "The 'edit-cells' operation requires edit access to this document"
   }
   ```
   `403 Forbidden`.

## Request schema

```ts
const cellUpdateSchema = z.object({
  address: z.string(),
  value: z.string(),
});

{
  operation: 'read' | 'replace' | 'insert' | 'delete' | 'edit-cells',
  pageId?: string,       // optional — falls back to the user's most recently
                          // modified owned page if omitted
  startLine?: number,    // replace / insert / delete
  endLine?: number,      // replace / delete (defaults to startLine)
  content?: string,      // replace / insert
  cells?: { address: string; value: string }[],  // edit-cells
}
```

## Operations

| Operation | Purpose | Requires |
|---|---|---|
| `read` | Return page content with numbered lines. For `TASK_LIST` pages, also returns tasks, `availableStatuses`, and progress rollups. | view |
| `replace` | Replace lines `startLine`–`endLine` with `content`. | edit |
| `insert` | Insert `content` before `startLine`. | edit |
| `delete` | Delete lines `startLine`–`endLine`. | edit |
| `edit-cells` | Set/clear cells on a `SHEET` page. See below. | edit |

`replace`/`insert`/`delete` all persist through `applyPageMutation` with
optimistic concurrency (see below), broadcast a `content-updated` websocket
event, and write a `data.write`/`data.delete` audit log entry. `read` writes a
`data.read` audit log entry and does not mutate anything.

## `edit-cells` — sheet editing

This is the only way to edit `SHEET` page content over the MCP HTTP API.
There is no separate `/api/mcp/sheets` or similar route — sheet edits go
through `/api/mcp/documents` with `operation: 'edit-cells'`.

### Validation, in order

1. **Page type.** `pageId` must resolve to a page where `isSheetType(page.type)`
   is true (`page.type === PageType.SHEET`, defined in
   `packages/lib/src/utils/enums.ts`). Otherwise:
   ```json
   {
     "error": "Page is not a sheet",
     "message": "This page is a DOCUMENT. Use edit-cells only on SHEET pages.",
     "pageType": "DOCUMENT"
   }
   ```
   `400 Bad Request`.
2. **Non-empty `cells`.** Otherwise:
   ```json
   { "error": "cells array is required for edit-cells operation" }
   ```
   `400 Bad Request`.
3. **Cell address format.** Each `cells[i].address` is validated with
   `isValidCellAddress` (`packages/lib/src/sheets/address.ts`) — trimmed,
   uppercased, and matched against `/^[A-Z]+\d+$/`. Up to the first 3 invalid
   addresses are echoed back:
   ```json
   {
     "error": "Invalid cell addresses: \"1A\", \"foo\", \"\". Use A1-style format (e.g., A1, B2, AA100)."
   }
   ```
   `400 Bad Request`.

### Behavior

- The page's sheet content is parsed (`parseSheetContent`), updated
  (`updateSheetCells`, `packages/lib/src/sheets/update.ts`), and re-serialized
  (`serializeSheetContent`).
- Per cell, the trimmed `value` decides the effect:
  - `""` (empty after trim) → the cell is **deleted**.
  - starts with `"="` → treated as a **formula**.
  - anything else → set as a plain **value**.
- The sheet's `rowCount`/`columnCount` grow automatically to fit any address
  that falls outside the current dimensions.
- Persistence goes through `applyPageMutation` with **optimistic
  concurrency**: the request effectively targets `page.revision`. If the
  page has moved on since the client last read it, the write is rejected with
  a `PageRevisionMismatchError`:
  - `428 Precondition Required` if no expected revision was available to
    check against.
  - `409 Conflict` on an actual revision mismatch.
  - Body in both cases:
    ```json
    { "error": "...", "currentRevision": 7, "expectedRevision": 5 }
    ```
- On success: broadcasts a `content-updated` websocket event to the page's
  drive room, and writes a `data.write` audit log entry
  (`eventType: 'data.write'`, `details.cellsUpdated`).

### Response

```jsonc
{
  "pageId": "pg_abc123",
  "pageTitle": "Q3 Budget",
  "cellsUpdated": 3,
  "operation": "edit-cells",
  "stats": {
    "valuesSet": 1,
    "formulasSet": 1,
    "cellsCleared": 1,
    "sheetDimensions": { "rows": 10, "columns": 5 }
  },
  "updatedCells": [
    { "address": "A1", "type": "value" },
    { "address": "B2", "type": "formula" },
    { "address": "C3", "type": "cleared" }
  ]
}
```

### Example request

```http
POST /api/mcp/documents
Authorization: Bearer mcp_abc123_xyz789
Content-Type: application/json

{
  "operation": "edit-cells",
  "pageId": "pg_abc123",
  "cells": [
    { "address": "A1", "value": "Revenue" },
    { "address": "B2", "value": "=SUM(B3:B10)" },
    { "address": "C3", "value": "" }
  ]
}
```

## Error handling summary

| Condition | Status | Body |
|---|---|---|
| No Bearer token / invalid `mcp_...` token | 401 | auth-error shaped by `authenticateMCPRequest` |
| Page's drive not in token's `allowedDriveIds` | 403 | `{ "error": "This token does not have access to this drive" }` |
| No view access to `pageId` | 403 | `"Forbidden"` (plain text) |
| Mutating op without edit access | 403 | `{ "error": "Write permission required", "details": "..." }` |
| Page not found | 404 | `{ "error": "Page not found" }` (or `{ "error": "No active document found" }` if `pageId` omitted and no fallback page exists) |
| `edit-cells` on a non-sheet page | 400 | `{ "error": "Page is not a sheet", "message": "...", "pageType": "..." }` |
| `edit-cells` with empty/missing `cells` | 400 | `{ "error": "cells array is required for edit-cells operation" }` |
| `edit-cells` with malformed cell address | 400 | `{ "error": "Invalid cell addresses: ..." }` |
| Zod schema validation failure | 400 | `{ "error": [...] }` (Zod issues array) |
| Revision conflict | 409 / 428 | `{ "error": "...", "currentRevision": n, "expectedRevision": n }` |
| Unrecognized `operation` | 400 | `{ "error": "Invalid operation" }` |
| Unhandled exception | 500 | `{ "error": "Failed to perform document operation" }` |
