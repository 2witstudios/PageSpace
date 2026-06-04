import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Permissions",
  description: "PageSpace access model: open-by-default drive membership, page privacy, direct page permissions with optional expiry, and per-drive custom roles — for people, agents, and connected apps.",
  path: "/docs/security/permissions",
  keywords: ["permissions", "authorization", "access control", "drive membership", "RBAC"],
});

const content = `
# Permissions

PageSpace resolves page access on every request, against the authoritative database — there is no permission cache between you and the answer. The model is **open within a drive, private by exception**: members of a drive see its pages by default, and you lock individual pages down when you need to.

## Who has access

### Drive owner

Every drive has exactly one owner, with unconditional view, edit, share, and delete on every page — including private ones. Ownership cannot be overridden by any other record.

### Drive admins

Members with the admin role get the same full access as the owner once they accept their invitation: every page, including private ones, plus the ability to manage members and roles.

### Drive members

A plain member sees every page in the drive that isn't marked private — no per-page grant required. On channels, members can post by default. Members don't get edit, share, or delete on other pages unless a grant or a role gives it to them, and they can't see pages marked private unless they're explicitly added.

### Agents and apps

AI agents and connected apps (MCP tokens) are drive members too, each with its own role on the drive. An agent or app can never see or do more than the member who added it, and its access is revoked automatically if that member is removed or downgraded.

### Page-level collaborators

Someone granted access to specific pages without being added to the drive. They reach exactly those pages and nothing else — a keyhole into the drive, not a key to the building.

## What gates a page

- **Page privacy.** Any page can be marked **private**. A private page drops out of the member baseline — only the owner, admins, and the people or roles explicitly granted access can see it. Marking a page private revokes the implicit member view immediately.
- **Direct page permissions.** Per-user, per-page flags — **view**, **edit**, **share**, **delete** — that grant access on top of (or, for a private page, instead of) the member baseline. Each grant can carry an optional expiry. Edit, Share, and Delete require View.
- **Custom roles.** A drive can define named roles (e.g. "Editor", "Reviewer") that carry their own per-page view/edit/share map. Custom roles are evaluated directly by the access check — a role can grant access to a page, and an explicit "no view" entry in a role acts as a deny.

**No inheritance for explicit grants.** A direct grant on a folder does not cascade to the pages inside it — each page is resolved on its own. (The member baseline is the opposite: members see every non-private page without any grant at all.)

## Authorization Flow

When a user requests a page, the server resolves access in this order:

1. Is the user the drive owner? → full access.
2. Does the user have an accepted admin membership? → full access.
3. Is there a non-expired direct page permission for this user? → the granted flags.
4. Does a custom role assigned to the user cover this page? → the role's flags.
5. Is the user an accepted member and the page isn't private? → view (and post, on channels).
6. Otherwise → deny.

### Example

Drive A is owned by Alice. It contains Folder X, which contains Document Y.

- **Alice** requests Document Y → full access via drive ownership.
- **Bob**, an accepted admin of Drive A → full access via drive admin membership.
- **Carol**, a member with a view+edit grant directly on Document Y → view and edit.
- **Dan**, a member with no grants → still sees Document Y (and the rest of the drive) because it isn't private. Mark Document Y private to hide it from him.
- **Eve**, whose direct grant on Document Y expired yesterday → falls back to the member baseline (sees it unless it's private).

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
