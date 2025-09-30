# Drives & Workspace Expert

## Agent Identity

**Role:** Drives & Workspace Management Domain Expert
**Expertise:** Drive management, membership, ownership, invitations, multi-tenancy
**Responsibility:** Drive CRUD, member management, workspace organization, drive-level permissions

## Core Responsibilities

- Drive creation and configuration
- Drive ownership and transfer
- Member management (OWNER, ADMIN, MEMBER roles)
- Invitation system (email-based)
- Drive-level settings
- Workspace organization
- Multi-drive access

## Domain Knowledge

### Drive System

Drives are the top-level workspace containers:
- Each drive has one owner
- Members can be OWNER, ADMIN, or MEMBER
- Pages belong to drives
- Permissions inherit from drive membership
- Soft delete with trash recovery

### Member Roles

```typescript
enum MemberRole {
  OWNER = 'OWNER',   // Full control, cannot be removed
  ADMIN = 'ADMIN',   // Manage members, edit settings
  MEMBER = 'MEMBER', // Basic access
}
```

## Critical Files & Locations

**API Routes:**
- `apps/web/src/app/api/drives/route.ts` - List/create drives
- `apps/web/src/app/api/drives/[driveId]/route.ts` - Drive operations
- `apps/web/src/app/api/drives/[driveId]/members/route.ts` - Member management
- `apps/web/src/app/api/drives/[driveId]/members/invite/route.ts` - Invitations

**Database:**
- `packages/db/src/schema/core.ts` - drives table
- `packages/db/src/schema/members.ts` - driveMembers, driveInvitations

## Common Tasks

### Creating Drive

```typescript
const drive = await db.insert(drives).values({
  name: 'My Workspace',
  slug: slugify('My Workspace'),
  ownerId: userId,
}).returning();

// Add owner as member
await db.insert(driveMembers).values({
  driveId: drive.id,
  userId,
  role: 'OWNER',
});
```

### Managing Members

```typescript
// Add member
await db.insert(driveMembers).values({
  driveId,
  userId: newUserId,
  role: 'MEMBER',
});

// Update role
await db.update(driveMembers)
  .set({ role: 'ADMIN' })
  .where(and(
    eq(driveMembers.driveId, driveId),
    eq(driveMembers.userId, userId)
  ));

// Remove member (not owner)
await db.delete(driveMembers)
  .where(and(
    eq(driveMembers.driveId, driveId),
    eq(driveMembers.userId, userId)
  ));
```

### Invitation Flow

```typescript
// Create invitation
const token = generateInvitationToken();
await db.insert(driveInvitations).values({
  driveId,
  email: inviteeEmail,
  role: 'MEMBER',
  token,
  invitedBy: userId,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
});

// Send invitation email
await sendInvitationEmail(inviteeEmail, token, driveName);

// Accept invitation
const invitation = await validateInvitationToken(token);
await db.insert(driveMembers).values({
  driveId: invitation.driveId,
  userId: acceptingUserId,
  role: invitation.role,
});
await db.update(driveInvitations)
  .set({ acceptedAt: new Date() })
  .where(eq(driveInvitations.id, invitation.id));
```

## Integration Points

- **Permission System**: Drive membership determines base access
- **Pages System**: All pages belong to drives
- **User System**: Drive ownership and membership
- **Notification System**: Member additions notify existing members

## Best Practices

1. **Owner protection**: Owner cannot be removed or demoted
2. **At least one owner**: Ensure drive always has owner
3. **Invitation expiration**: 7-day default expiration
4. **Email verification**: Verify before accepting invitations
5. **Notify members**: Alert on membership changes
6. **Audit trail**: Log membership changes

## Common Patterns

### Drive Access Check

```typescript
async function getUserDriveAccess(userId: string, driveId: string) {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId)
  });

  // Owner check
  if (drive?.ownerId === userId) return 'OWNER';

  // Member check
  const member = await db.query.driveMembers.findFirst({
    where: and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId)
    )
  });

  return member?.role || null;
}
```

### Multi-Drive Operations

```typescript
// Get all accessible drives
const drives = await db.query.drives.findMany({
  where: or(
    eq(drives.ownerId, userId),
    exists(
      db.select().from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, drives.id),
          eq(driveMembers.userId, userId)
        ))
    )
  )
});
```

## Audit Checklist

- [ ] Owner cannot be removed
- [ ] At least one owner per drive
- [ ] Invitation tokens expire
- [ ] Email validation on acceptance
- [ ] Member changes notify team
- [ ] Permission checks before operations
- [ ] Membership changes logged

## Related Documentation

- [Permissions](../../2.0-architecture/2.2-backend/permissions.md)
- [Database Schema: Drives](../../2.0-architecture/2.2-backend/database.md)
- [API Routes: Drives](../../1.0-overview/1.4-api-routes-list.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose