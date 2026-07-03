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
  pageId: string,         // required — no "current page" fallback
  startLine?: number,     // read (ranged) / replace / insert / delete
  endLine?: number,       // read (ranged) / replace / delete (defaults to startLine)
  content?: string,       // replace / insert
  cells?: { address: string; value: string }[],  // edit-cells
}
```

**`pageId` is required.** There used to be a fallback to
`getCurrentPageId(userId)` when it was omitted — a broken, unpredictable
"most recently updated page" lookup with no relation to the calling agent's
actual target. It has been removed. Omitting `pageId` now fails Zod
validation and returns `400` with the schema issues, before any page is
touched.

## Operations

| Operation | Purpose | Requires |
|---|---|---|
| `read` | Return page content with numbered lines. Supports `startLine`/`endLine` for a ranged read (1-indexed, inclusive). `TASK_LIST` pages return tasks, `availableStatuses`, progress rollups, `parentTaskList`, and per-task `subTaskCount`/`subTaskCompletedCount` instead of line content. `CHANNEL` pages return a numbered message transcript (`startLine`/`endLine` address message index, not line number). `FILE` pages surface `processingStatus` (`pending`/`processing`/`failed`/`visual` short-circuit with a status body; `completed` returns content plus `fileMetadata`). | view |
| `replace` | Replace lines `startLine`–`endLine` with `content`. Rejected on `FILE`/`SHEET` pages (400 — see guardrails below). | edit |
| `insert` | Insert `content` before `startLine`. Rejected on `FILE`/`SHEET` pages. | edit |
| `delete` | Delete lines `startLine`–`endLine`. Rejected on `FILE`/`SHEET` pages. | edit |
| `edit-cells` | Set/clear cells on a `SHEET` page. See below. | edit |

`replace`/`insert`/`delete` all persist through `applyPageMutation` with the
same in-request revision check described under `edit-cells` below (it guards
a narrow same-request race, not general client stale-read protection),
broadcast a `content-updated` websocket event, and write a
`data.write`/`data.delete` audit log entry. `read` writes a `data.read` audit
log entry and does not mutate anything.

### Line numbering

`read` and the line-based write operations number lines from the page's
content serialized through `serializePageContentForAI`
(`apps/web/src/lib/ai/core/page-serializer.ts`) — the same normalization the
in-process `read_page`/`replace_lines` AI tools use. CODE pages and
`contentMode: 'markdown'` documents pass through raw (their content already
has natural line structure, and normalizing raw code/markdown would mangle
it). Everything else (plain HTML documents) is expanded via
`addLineBreaksForAI` so line numbers correspond to block-level elements
instead of collapsing the whole stored document into one line. A line number
seen from a `read` always addresses the same content on a subsequent
`replace`/`insert`/`delete` against the same page.

Writes mirror that same `isRawText` check: CODE/markdown content is written
back exactly as spliced, with no re-normalization; HTML documents are
re-normalized with `addLineBreaksForAI` after the splice.

## `edit-cells` — sheet editing

This is the intended, cell-aware way to edit `SHEET` page content over the
MCP HTTP API. There is no separate `/api/mcp/sheets` or similar route —
sheet edits go through `/api/mcp/documents` with `operation: 'edit-cells'`.

The `replace`/`insert`/`delete` branches check `isSheetType(page.type)` before
touching content and reject with `400` on a `SHEET` page:
```json
{
  "error": "Cannot use line editing on sheets",
  "message": "Sheet pages use structured cell data. Use the edit-cells operation instead for cell-level edits.",
  "suggestion": "Use operation: \"edit-cells\" with cell addresses (A1, B2, etc.) to modify sheet content."
}
```
A raw line splice against a sheet's serialized TOML representation (bypassing
`parseSheetContent`/`updateSheetCells`) can desync rows/columns or produce
invalid content — this guardrail mirrors the equivalent check in the
in-process `replace_lines` AI tool. Always use `edit-cells` for `SHEET` pages.

`FILE` pages are rejected the same way (`400`) from all three line-editing
operations — uploaded file content is read-only and system-managed:
```json
{
  "error": "Cannot edit FILE pages",
  "message": "This is an uploaded file. File content is read-only and managed by the system.",
  "suggestion": "To modify content, create a new document page instead of editing the uploaded file."
}
```

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
- Persistence goes through `applyPageMutation`
  (`apps/web/src/services/api/page-mutation-service.ts`), which does a
  revision check — but **not** the general "reject if the page changed since
  the client last read it" guarantee it might suggest. `lineOperationSchema`
  has no `expectedRevision` field, so a client cannot pass in the revision it
  saw from an earlier `read` call. Instead, the route passes its own
  just-fetched `page.revision` (fetched moments earlier in the *same* POST
  request, `route.ts` ~line 167) as `expectedRevision`, and
  `applyPageMutation` re-fetches the page again internally and compares. The
  only thing this actually guards against is another write landing in the
  narrow window between those two in-request fetches — it does not protect a
  client that read the page via a separate `read` call, waited, and then
  submitted `edit-cells` against content that has since changed elsewhere.
  Since `pages.revision` is a `NOT NULL integer` (`packages/db/src/schema/core.ts`),
  `expectedRevision` is always defined in practice, so the `428` path below
  is not reachable via this route; a `409` is possible only if a concurrent
  write happens to land inside that narrow in-request window.
  On a genuine mismatch, `PageRevisionMismatchError` is thrown:
  - `409 Conflict` on a revision mismatch.
  - `428 Precondition Required` in the (here, unreachable) case where no
    expected revision was available to check against — this path exists for
    other callers of `applyPageMutation` that may omit it.
  - Body in both cases:
    ```json
    { "error": "...", "currentRevision": 7, "expectedRevision": 5 }
    ```
  If you need real stale-read protection, compare content or a hash
  client-side before writing — this endpoint does not expose one.
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
| `pageId` omitted or any other schema violation | 400 | `{ "error": [...] }` (Zod issues array) — fails before any page lookup |
| Page's drive not in token's `allowedDriveIds` | 403 | `{ "error": "This token does not have access to this drive" }` |
| No view access to `pageId` | 403 | `"Forbidden"` (plain text) |
| Mutating op without edit access | 403 | `{ "error": "Write permission required", "details": "..." }` |
| Page not found | 404 | `{ "error": "Page not found" }` |
| `replace`/`insert`/`delete` on a `FILE` page | 400 | `{ "error": "Cannot edit FILE pages", "message": "...", "suggestion": "...", "pageInfo": {...} }` |
| `replace`/`insert`/`delete` on a `SHEET` page | 400 | `{ "error": "Cannot use line editing on sheets", "message": "...", "suggestion": "...", "pageInfo": {...} }` |
| `edit-cells` on a non-sheet page | 400 | `{ "error": "Page is not a sheet", "message": "...", "pageType": "..." }` |
| `edit-cells` with empty/missing `cells` | 400 | `{ "error": "cells array is required for edit-cells operation" }` |
| `edit-cells` with malformed cell address | 400 | `{ "error": "Invalid cell addresses: ..." }` |
| Invalid line range on `read`/`replace`/`delete` | 400 | `{ "error": "Invalid line range: ..." }` or `{ "error": "Line number out of range" }` |
| Revision conflict (rare — only a same-request race; see `edit-cells` above) | 409 | `{ "error": "...", "currentRevision": n, "expectedRevision": n }` |
| Unrecognized `operation` | 400 | `{ "error": "Invalid operation" }` |
| Unhandled exception | 500 | `{ "error": "Failed to perform document operation" }` |
