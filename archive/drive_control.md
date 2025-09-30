# Drive Control Implementation Guide

This document describes how drive management features (rename, trash/delete, restore) were implemented in PageSpace. This guide is intended for AI assistants and developers who need to implement these features as tool calls for AI SDK or MCP (Model Context Protocol) integrations.

## Overview

Drive management in PageSpace follows a soft-delete pattern with trash/restore functionality, similar to how pages are handled. The implementation includes:

1. **Rename** - Change drive name
2. **Soft Delete** - Move to trash (recoverable)
3. **Restore** - Recover from trash
4. **Permanent Delete** - Irreversible removal

## Database Schema

### Drive Table Structure
Located in `packages/db/src/schema/core.ts`:

```typescript
export const drives = pgTable('drives', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
});
```

### Key Fields for Trash System
- `isTrashed`: Boolean flag indicating if drive is in trash
- `trashedAt`: Timestamp when drive was moved to trash
- `ownerId`: Only drive owners can rename/delete their drives

## API Endpoints

### 1. Rename Drive
**Endpoint:** `PATCH /api/drives/[driveId]`  
**File:** `apps/web/src/app/api/drives/[driveId]/route.ts`

```typescript
// Request body
{
  "name": "New Drive Name"
}

// Implementation
export async function PATCH(request: Request, context: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await context.params;
  const userId = await getUserId(request);
  
  // Verify ownership
  const drive = await db.query.drives.findFirst({
    where: and(
      eq(drives.id, driveId),
      eq(drives.ownerId, userId)
    ),
  });
  
  if (!drive) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  
  // Update drive name
  await db.update(drives)
    .set({
      name: newName,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, drive.id));
    
  return NextResponse.json(updatedDrive);
}
```

### 2. Move to Trash (Soft Delete)
**Endpoint:** `DELETE /api/drives/[driveId]`  
**File:** `apps/web/src/app/api/drives/[driveId]/route.ts`

```typescript
export async function DELETE(request: Request, context: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await context.params;
  const userId = await getUserId(request);
  
  // Verify ownership
  const drive = await db.query.drives.findFirst({
    where: and(
      eq(drives.id, driveId),
      eq(drives.ownerId, userId)
    ),
  });
  
  if (!drive) {
    return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
  }
  
  // Move to trash
  await db.update(drives)
    .set({
      isTrashed: true,
      trashedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(drives.id, drive.id));
    
  return NextResponse.json({ success: true });
}
```

### 3. Restore from Trash
**Endpoint:** `POST /api/drives/[driveId]/restore`  
**File:** `apps/web/src/app/api/drives/[driveId]/restore/route.ts`

```typescript
export async function POST(request: Request, context: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await context.params;
  const userId = await getUserId(request);
  
  // Verify ownership and trash status
  const drive = await db.query.drives.findFirst({
    where: and(
      eq(drives.id, driveId),
      eq(drives.ownerId, userId)
    ),
  });
  
  if (!drive || !drive.isTrashed) {
    return NextResponse.json({ error: 'Drive not found or not in trash' }, { status: 400 });
  }
  
  // Restore from trash
  await db.update(drives)
    .set({
      isTrashed: false,
      trashedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(drives.id, drive.id));
    
  return NextResponse.json({ success: true });
}
```

### 4. Permanent Delete
**Endpoint:** `DELETE /api/trash/drives/[driveId]`  
**File:** `apps/web/src/app/api/trash/drives/[driveId]/route.ts`

```typescript
export async function DELETE(request: Request, context: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await context.params;
  const userId = await getUserId(request);
  
  // Verify ownership and trash status
  const drive = await db.query.drives.findFirst({
    where: and(
      eq(drives.id, driveId),
      eq(drives.ownerId, userId)
    ),
  });
  
  if (!drive || !drive.isTrashed) {
    return NextResponse.json({ error: 'Drive must be in trash before permanent deletion' }, { status: 400 });
  }
  
  // Permanently delete (cascade will delete all pages)
  await db.delete(drives)
    .where(eq(drives.id, drive.id));
    
  return NextResponse.json({ success: true });
}
```

### 5. List Drives (with trash filter)
**Endpoint:** `GET /api/drives?includeTrash=true`  
**File:** `apps/web/src/app/api/drives/route.ts`

```typescript
export async function GET(req: Request) {
  const userId = await getUserId(req);
  const url = new URL(req.url);
  const includeTrash = url.searchParams.get('includeTrash') === 'true';
  
  // Get owned drives
  const ownedDrives = await db.query.drives.findMany({
    where: includeTrash 
      ? eq(drives.ownerId, userId)
      : and(
          eq(drives.ownerId, userId),
          eq(drives.isTrashed, false)
        ),
  });
  
  // Add isOwned flag
  const allDrives = [
    ...ownedDrives.map((drive) => ({ ...drive, isOwned: true })),
    ...sharedDrives.map((drive) => ({ ...drive, isOwned: false })),
  ];
  
  return NextResponse.json(allDrives);
}
```

## Frontend Implementation

### State Management
Uses Zustand store (`apps/web/src/hooks/useDrive.ts`):

```typescript
interface DriveState {
  drives: Drive[];
  fetchDrives: (includeTrash?: boolean, forceRefresh?: boolean) => Promise<void>;
  addDrive: (drive: Drive) => void;
  setCurrentDrive: (driveId: string | null) => void;
}
```

### UI Components

#### Drive List with Settings Menu
Located in `apps/web/src/components/layout/left-sidebar/DriveList.tsx`:

```typescript
const handleRenameDrive = async (newName: string) => {
  const response = await fetch(`/api/drives/${drive.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (response.ok) {
    await fetchDrives(true, true); // Force refresh
    toast.success("Drive renamed.");
  }
};

const handleDeleteDrive = async () => {
  const response = await fetch(`/api/drives/${drive.id}`, {
    method: "DELETE",
  });
  if (response.ok) {
    await fetchDrives(true, true); // Force refresh
    toast.success("Drive moved to trash.");
  }
};
```

#### Dialogs
- **RenameDialog** (`apps/web/src/components/dialogs/RenameDialog.tsx`) - Reusable rename dialog
- **DeleteDriveDialog** (`apps/web/src/components/dialogs/DeleteDriveDialog.tsx`) - Confirmation for trash operation

## Tool Call Implementation for AI/MCP

### For AI SDK Tool Definition

```typescript
const driveTools = {
  renameDrive: {
    description: "Rename a drive",
    parameters: z.object({
      driveId: z.string().describe("The drive ID to rename"),
      newName: z.string().describe("The new name for the drive"),
    }),
    execute: async ({ driveId, newName }) => {
      const response = await fetch(`/api/drives/${driveId}`, {
        method: "PATCH",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}` // Include auth
        },
        body: JSON.stringify({ name: newName }),
      });
      return response.json();
    },
  },
  
  deleteDrive: {
    description: "Move a drive to trash",
    parameters: z.object({
      driveId: z.string().describe("The drive ID to delete"),
    }),
    execute: async ({ driveId }) => {
      const response = await fetch(`/api/drives/${driveId}`, {
        method: "DELETE",
        headers: { 
          "Authorization": `Bearer ${token}`
        },
      });
      return response.json();
    },
  },
  
  restoreDrive: {
    description: "Restore a drive from trash",
    parameters: z.object({
      driveId: z.string().describe("The drive ID to restore"),
    }),
    execute: async ({ driveId }) => {
      const response = await fetch(`/api/drives/${driveId}/restore`, {
        method: "POST",
        headers: { 
          "Authorization": `Bearer ${token}`
        },
      });
      return response.json();
    },
  },
  
  permanentlyDeleteDrive: {
    description: "Permanently delete a drive from trash",
    parameters: z.object({
      driveId: z.string().describe("The drive ID to permanently delete"),
    }),
    execute: async ({ driveId }) => {
      const response = await fetch(`/api/trash/drives/${driveId}`, {
        method: "DELETE",
        headers: { 
          "Authorization": `Bearer ${token}`
        },
      });
      return response.json();
    },
  },
  
  listDrives: {
    description: "List all drives, optionally including trashed ones",
    parameters: z.object({
      includeTrash: z.boolean().optional().describe("Whether to include trashed drives"),
    }),
    execute: async ({ includeTrash = false }) => {
      const url = includeTrash ? '/api/drives?includeTrash=true' : '/api/drives';
      const response = await fetch(url, {
        headers: { 
          "Authorization": `Bearer ${token}`
        },
      });
      return response.json();
    },
  },
};
```

### For MCP Tool Implementation

```json
{
  "tools": [
    {
      "name": "rename_drive",
      "description": "Rename a drive",
      "inputSchema": {
        "type": "object",
        "properties": {
          "driveId": {
            "type": "string",
            "description": "The ID of the drive to rename"
          },
          "newName": {
            "type": "string",
            "description": "The new name for the drive"
          }
        },
        "required": ["driveId", "newName"]
      }
    },
    {
      "name": "delete_drive",
      "description": "Move a drive to trash (soft delete)",
      "inputSchema": {
        "type": "object",
        "properties": {
          "driveId": {
            "type": "string",
            "description": "The ID of the drive to delete"
          }
        },
        "required": ["driveId"]
      }
    },
    {
      "name": "restore_drive",
      "description": "Restore a drive from trash",
      "inputSchema": {
        "type": "object",
        "properties": {
          "driveId": {
            "type": "string",
            "description": "The ID of the drive to restore"
          }
        },
        "required": ["driveId"]
      }
    }
  ]
}
```

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

## Future Enhancements

1. **Bulk Operations** - Select multiple drives for batch delete/restore
2. **Trash Retention Policy** - Auto-delete after X days
3. **Activity Logging** - Track who renamed/deleted drives
4. **Shared Drive Permissions** - Allow shared users to rename with permission
5. **Undo Feature** - Quick undo for accidental deletions
6. **Search in Trash** - Filter/search trashed items