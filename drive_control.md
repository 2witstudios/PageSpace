# Drive Control Implementation Guide

This document describes how drive management features (rename, trash/delete, restore) were implemented in PageSpace. This guide is intended for AI assistants and developers who need to implement these features as tool calls for AI SDK or MCP (Model Context Protocol) integrations.

## Overview

Drive management in PageSpace follows a soft-delete pattern with trash/restore functionality, similar to how pages are handled. The implementation includes:

1. **Rename** - Change drive name
2. **Soft Delete** - Move to trash (recoverable)
3. **Restore** - Recover from trash
4. **Permanent Delete** - Irreversible removal


## Important Implementation Details

### 1. Authentication
All endpoints require authentication via:
- Cookie-based auth (accessToken)
- MCP Bearer token (for external integrations)

### 2. Ownership Verification
Only drive owners can:
- Rename their drives
- Delete their drives
- Restore their drives
- Permanently delete their drives

### 3. Cascade Behavior
When a drive is deleted:
- All pages within the drive remain associated
- Permanent deletion cascades to all pages (due to foreign key constraint)

### 4. Trash System
- Soft delete first (isTrashed = true)
- Can be restored from trash
- Permanent delete only allowed from trash state
- Trash view shows both drives and pages

### 5. UI/UX Considerations
- Settings menu appears on hover in sidebar
- Confirmation dialogs for destructive actions
- Toast notifications for user feedback
- Force refresh after mutations to ensure UI consistency

## Testing the Implementation

### Manual Testing
1. Create a drive
2. Rename it via the 3-dot menu in sidebar
3. Delete it (moves to trash)
4. View in trash section
5. Restore from trash
6. Delete again and permanently delete

### API Testing with cURL

```bash
# Rename drive
curl -X PATCH http://localhost:3000/api/drives/{driveId} \
  -H "Content-Type: application/json" \
  -H "Cookie: accessToken={token}" \
  -d '{"name": "New Name"}'

# Delete drive (to trash)
curl -X DELETE http://localhost:3000/api/drives/{driveId} \
  -H "Cookie: accessToken={token}"

# Restore from trash
curl -X POST http://localhost:3000/api/drives/{driveId}/restore \
  -H "Cookie: accessToken={token}"

# Permanently delete
curl -X DELETE http://localhost:3000/api/trash/drives/{driveId} \
  -H "Cookie: accessToken={token}"

# List drives (including trash)
curl http://localhost:3000/api/drives?includeTrash=true \
  -H "Cookie: accessToken={token}"
```
