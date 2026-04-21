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

PageSpace resolves page access against three primitives, checked in order on every request. Every check hits the database directly — there is no permission cache between you and the authoritative answer.

## The Three Primitives

### 1. Drive ownership

Every drive has exactly one owner. The owner has unconditional view, edit, share, and delete capability on every page in the drive. Ownership cannot be overridden by any other record.

### 2. Drive admin membership

Drive members with admin role, once they accept their invitation, get the same full page access as the owner. Non-admin members are a membership record only — they don't automatically get page-level access. Page-level access for non-admin members is carried by direct page permissions (below).

### 3. Direct page permissions

Per-user, per-page capability flags: **view**, **edit**, **share**, **delete**. Each grant can optionally carry an expiry — the grant stops being honored once the expiry passes, and expired rows can be kept for audit without re-exposing access.

**No inheritance.** A grant on a folder does not imply a grant on any page inside it. Each page is checked independently. This prevents the classic "accidentally shared the whole subtree" class of mistake.

## Authorization Flow

When a user requests access to a page, the server resolves access in this order:

1. Is the user the drive owner? → full access.
2. Does the user have an accepted admin membership on the drive? → full access.
3. Is there a non-expired direct page permission for this user on this page? → return the granted capabilities.
4. Otherwise → deny.

### Example

Drive A is owned by Alice. It contains Folder X, which contains Document Y.

- **Alice** requests Document Y → full access via drive ownership.
- **Bob**, an accepted admin of Drive A, requests Document Y → full access via drive admin membership.
- **Carol**, a drive member with a view+edit grant directly on Document Y → view and edit.
- **Dan**, a drive member with a grant on Folder X but no grant on Document Y → denied (no inheritance).
- **Eve** has a direct grant on Document Y that expired yesterday → denied.

## Role Templates

Drive owners and admins can define custom role templates, scoped to a single drive, that bundle common capability flags into a named role — useful for consistent "Editor", "Reviewer", "Viewer" patterns across many pages. Templates are a convenience layer; the canonical access check still resolves against the three primitives above.

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

Requires drive ownership, drive admin membership, or share capability on the target page.

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
