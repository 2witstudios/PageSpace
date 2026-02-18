import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Permissions",
  description: "PageSpace RBAC permission model: drive ownership, direct page permissions, boolean flags, cache strategy, and authorization flow.",
  path: "/docs/security/permissions",
  keywords: ["permissions", "RBAC", "authorization", "access control", "drive membership"],
});

const content = `
# Permissions

PageSpace uses a direct permission model built on three concepts: **drive ownership**, **drive membership**, and **page-level permissions**.

## Core Concepts

### Drive Ownership

Every drive has a single owner with irrevocable full access. The owner can:
- View, edit, share, and delete any page in the drive
- Manage drive members and their roles
- Configure drive-level AI settings
- This cannot be overridden by any other permission setting

### Drive Membership

Users can be added to drives with one of three roles:

| Role | Capabilities |
|------|-------------|
| OWNER | Full access to everything in the drive |
| ADMIN | Drive management, member management |
| MEMBER | Basic drive visibility, page access based on page permissions |

### Page Permissions

Direct user-to-page permissions with boolean flags:

| Flag | Description |
|------|-------------|
| \`canView\` | Read page content |
| \`canEdit\` | Modify page content |
| \`canShare\` | Manage page permissions (share with other users) |
| \`canDelete\` | Move page to trash |

Each permission is a direct relationship — User X has specific permissions on Page Y. There is no permission inheritance from parent pages.

## Authorization Flow

When a user requests access to a page:

1. **Check drive ownership**: If the user owns the drive, grant full access immediately
2. **Check direct permissions**: Look up the user's permission record on the specific page
3. **Return permissions**: If a record exists, return the boolean flags
4. **Deny access**: If no record exists, deny access

\`\`\`
User requests Page Y
  └→ Is user the drive owner?
      ├→ Yes → Full access (view, edit, share, delete)
      └→ No → Check pagePermissions table
               ├→ Record found → Return { canView, canEdit, canShare, canDelete }
               └→ No record → Access denied
\`\`\`

### Example

Drive A is owned by Alice. It contains Folder X, which contains Document Y.

- **Alice** requests Document Y → Full access (drive owner)
- **Bob** has \`canView: true, canEdit: true\` on Document Y → Can view and edit
- **Charlie** has permissions on Folder X but not Document Y → Access denied (no inheritance)

## Permission Management

### Granting Permissions

\`\`\`typescript
POST /api/pages/{pageId}/permissions
{
  "userId": "user-bob-123",
  "canView": true,
  "canEdit": true,
  "canShare": false,
  "canDelete": false
}
\`\`\`

Requires: Drive owner or \`canShare\` permission on the page.

### Revoking Permissions

\`\`\`typescript
DELETE /api/pages/{pageId}/permissions
{
  "userId": "user-bob-123"
}
\`\`\`

### Checking Permissions

\`\`\`typescript
GET /api/pages/{pageId}/permissions/check
// Returns: { canView: true, canEdit: true, canShare: false, canDelete: false }
\`\`\`

### Drive Permission Tree

Drive owners can view a hierarchical permissions overview:

\`\`\`typescript
GET /api/drives/{driveId}/permissions-tree?userId=user-bob-123
// Returns all pages with Bob's permission status
\`\`\`

## Permission Cache

Permissions are cached using a two-tier strategy:

| Tier | Storage | TTL | Max Entries |
|------|---------|-----|-------------|
| L1 | In-memory Map | 60s | 1,000 |
| L2 | Redis | 60s | Unlimited |

### Cache Behavior

- **Read operations** (viewing pages): Use cache — stale data is acceptable
- **Write operations** (editing, deleting): Bypass cache — must verify current permissions
- **Permission changes** (grant/revoke): Bypass cache + invalidate existing entries

### Failure Behavior

| Scenario | Behavior |
|----------|----------|
| Cache miss | Falls through to database query, result cached |
| Redis unavailable | L1 cache still operates, no denial of service |
| Invalidation failure | Logged, stale entry expires within 60s TTL |
| Database error | Returns null (access denied) |

Cache failures never result in unauthorized access — the system always falls through to the database on error.

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | \`/api/pages/{id}/permissions\` | List all permissions for a page |
| POST | \`/api/pages/{id}/permissions\` | Grant or update permissions |
| DELETE | \`/api/pages/{id}/permissions\` | Revoke user's permissions |
| GET | \`/api/pages/{id}/permissions/check\` | Check current user's permissions |
| GET | \`/api/drives/{id}/permissions-tree\` | Hierarchical permissions view |
| POST | \`/api/permissions/batch\` | Batch permission updates |
`;

export default function PermissionsPage() {
  return <DocsMarkdown content={content} />;
}
