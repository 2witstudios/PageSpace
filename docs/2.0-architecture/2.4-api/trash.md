# Trash Routes

### DELETE /api/trash/[pageId]

**Purpose:** Permanently deletes a trashed page and its children from the database.
**Auth Required:** Yes
**Request Schema:**
- pageId: string (dynamic parameter - ID of the page to permanently delete, must await context.params in Next.js 15)
**Response Schema:** Message object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern (params are Promises)
- Recursively deletes all child pages
- Permanently removes from database (not recoverable)
- Checks user has DELETE permission on the page
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21