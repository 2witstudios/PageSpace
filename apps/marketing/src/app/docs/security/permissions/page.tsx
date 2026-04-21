import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Permissions",
  description: "PageSpace access model: drive ownership, drive admin membership, direct page permissions with optional expiry, and per-drive role templates.",
  path: "/docs/security/permissions",
  keywords: ["permissions", "authorization", "access control", "drive membership", "RBAC"],
});

const content = `
# Permissions

PageSpace resolves page access against three primitives, checked in order on every request. There is no permission cache; every check queries Postgres directly.

Source: \`packages/lib/src/permissions/permissions.ts\`, \`packages/db/drizzle/0102_accessible_page_ids_for_user.sql\`, \`packages/db/src/schema/members.ts\`.

## The Three Primitives

### 1. Drive ownership — \`drives.ownerId\`

Every drive has exactly one owner, recorded directly on the \`drives\` row. The owner has unconditional \`canView\`, \`canEdit\`, \`canShare\`, and \`canDelete\` on every page in the drive. Ownership cannot be overridden by any other record.

Ownership is tracked on \`drives.ownerId\`, not on \`drive_members\`.

### 2. Drive admin membership — \`drive_members\`

Users added to a drive get a \`drive_members\` row:

| Column | Notes |
|--------|-------|
| \`role\` | \`ADMIN\` or \`MEMBER\`. The canonical viewer only elevates \`ADMIN\`. |
| \`acceptedAt\` | Must be non-null — pending invitations do not grant access. |
| \`customRoleId\` | Optional reference to a drive-scoped role template (see below). |
| \`invitedBy\` / \`invitedAt\` | Audit fields. |

An accepted \`ADMIN\` row grants full page access across the whole drive, equivalent to the owner for day-to-day operations. \`MEMBER\` rows are a membership record only — they do not grant page-level access by themselves. Page-level access for members is carried by \`page_permissions\` rows.

### 3. Direct page permissions — \`page_permissions\`

Per-user, per-page flags:

| Flag | Action |
|------|--------|
| \`canView\` | Read page content |
| \`canEdit\` | Modify content |
| \`canShare\` | Grant / revoke permissions on the page |
| \`canDelete\` | Send page to trash |

Additional columns:

- \`expiresAt\` — optional. A row is only honored while \`expiresAt IS NULL OR expiresAt > now()\`. Expired grants are ignored automatically and can be kept for audit.
- \`grantedBy\` / \`grantedAt\` — who granted the permission and when.
- \`note\` — free-text annotation for the grant.

There is no inheritance from parent pages. A grant on a folder does not imply a grant on any page inside it. Each page is checked independently.

## Authorization Flow

When a user requests access to a page, the server applies these checks in order:

\`\`\`
User → Page Y
  ├─ Drive.ownerId === user? ─────────── yes → full access
  ├─ drive_members row for this drive where
  │    userId=user AND role='ADMIN' AND acceptedAt IS NOT NULL? ─ yes → full access
  ├─ page_permissions row for (userId=user, pageId=Y) where
  │    expiresAt IS NULL OR expiresAt > now()? ─────── yes → return the stored flags
  └─ otherwise ─────────────────────────────────────── deny
\`\`\`

This is implemented both in TypeScript (\`getUserAccessLevel\` in \`packages/lib/src/permissions/permissions.ts\`) and in the Postgres function \`accessible_page_ids_for_user(uid)\` (migration \`0102_accessible_page_ids_for_user.sql\`) for bulk queries.

### Example

Drive A is owned by Alice. It contains Folder X, which contains Document Y.

- **Alice** requests Document Y → full access via drive ownership.
- **Bob**, accepted \`ADMIN\` of Drive A, requests Document Y → full access via drive admin membership.
- **Carol**, \`MEMBER\` of Drive A, has \`page_permissions\` on Document Y with \`canView=true, canEdit=true\`, no \`expiresAt\` → view and edit.
- **Dan**, \`MEMBER\` of Drive A, has \`canView=true\` on Folder X but no row on Document Y → denied (no inheritance).
- **Eve** has a \`page_permissions\` row on Document Y with \`canView=true\` and \`expiresAt\` yesterday → denied (expired).

## Role Templates — \`drive_roles\`

Drive owners and admins can define custom role templates, scoped to a single drive, that bundle page-level capability flags:

\`\`\`typescript
// packages/db/src/schema/members.ts
drive_roles: {
  id, driveId, name, description, color,
  isDefault: boolean,
  permissions: Record<string, { canView, canEdit, canShare }>,
  position, createdAt, updatedAt
}
\`\`\`

A \`drive_members\` row can reference a template via \`customRoleId\`. Templates are a convenience layer on top of \`drive_members.role\` + \`page_permissions\`; the canonical access check still resolves against the three primitives above.

## Permission Management

### Granting

\`\`\`
POST /api/pages/{pageId}/permissions
{
  "userId": "user_...",
  "canView": true,
  "canEdit": true,
  "canShare": false,
  "canDelete": false,
  "expiresAt": "2026-06-01T00:00:00.000Z"  // optional
}
\`\`\`

Requires drive ownership, drive admin membership, or \`canShare\` on the target page.

### Revoking

\`\`\`
DELETE /api/pages/{pageId}/permissions
{ "userId": "user_..." }
\`\`\`

### Checking

\`\`\`
GET /api/pages/{pageId}/permissions/check
// → { canView, canEdit, canShare, canDelete } for the current user
\`\`\`

### Drive-wide View

\`\`\`
GET /api/drives/{driveId}/permissions-tree?userId=user_...
// → per-page permission status for the named user across the whole drive
\`\`\`

Requires drive ownership or admin membership.

### Batch Updates

\`\`\`
POST /api/permissions/batch
// Apply multiple page-permission changes in one request
\`\`\`

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | \`/api/pages/{id}/permissions\` | List grants on a page (for users who can share) |
| POST | \`/api/pages/{id}/permissions\` | Grant or update a user's permissions on a page |
| DELETE | \`/api/pages/{id}/permissions\` | Revoke a user's permissions on a page |
| GET | \`/api/pages/{id}/permissions/check\` | Current user's flags on a page |
| GET | \`/api/drives/{id}/permissions-tree\` | Per-page status across a drive |
| POST | \`/api/permissions/batch\` | Apply multiple page-permission changes atomically |
`;

export default function PermissionsPage() {
  return <DocsMarkdown content={content} />;
}
