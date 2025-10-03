import { NextResponse } from 'next/server';
import { db, eq, and } from '@pagespace/db';
import { driveMembers, drives, pagePermissions, pages } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { createDriveNotification, isEmailVerified } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

interface PermissionEntry {
  pageId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check email verification
    const emailVerified = await isEmailVerified(user.id);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { userId: invitedUserId, role = 'MEMBER', permissions } = body as {
      userId: string;
      role?: 'MEMBER' | 'ADMIN';
      permissions: PermissionEntry[];
    };

    // Check if user is drive owner or admin
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive[0].ownerId === user.id;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, user.id),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can add members' }, { status: 403 });
    }

    // Check if member already exists
    const existingMember = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, invitedUserId)
      ))
      .limit(1);

    let memberId: string;
    
    if (existingMember.length === 0) {
      // Add as drive member with specified role
      const newMember = await db.insert(driveMembers)
        .values({
          driveId,
          userId: invitedUserId,
          role,
          invitedBy: user.id,
          acceptedAt: new Date(), // Auto-accept for now
        })
        .returning();

      memberId = newMember[0].id;
    } else {
      // Update role if member exists
      await db.update(driveMembers)
        .set({ role })
        .where(eq(driveMembers.id, existingMember[0].id));

      memberId = existingMember[0].id;
    }

    // Validate that all pageIds belong to this drive
    const validPages = await db.select({ id: pages.id })
      .from(pages)
      .where(and(
        eq(pages.driveId, driveId),
        // This would need inArray but we'll validate one by one for now
      ));
    
    const validPageIds = new Set(validPages.map(p => p.id));

    // Add permissions for each page
    const permissionPromises = permissions.map(async (perm) => {
      if (!validPageIds.has(perm.pageId)) {
        loggers.api.warn(`Invalid page ID ${perm.pageId} for drive ${driveId}`);
        return null;
      }

      // Check if permission already exists
      const existing = await db.select()
        .from(pagePermissions)
        .where(and(
          eq(pagePermissions.pageId, perm.pageId),
          eq(pagePermissions.userId, invitedUserId)
        ))
        .limit(1);

      if (existing.length > 0) {
        // Update existing permission
        return db.update(pagePermissions)
          .set({
            canView: perm.canView,
            canEdit: perm.canEdit,
            canShare: perm.canShare,
            grantedBy: user.id,
            grantedAt: new Date(),
          })
          .where(eq(pagePermissions.id, existing[0].id))
          .returning();
      } else {
        // Create new permission
        return db.insert(pagePermissions)
          .values({
            pageId: perm.pageId,
            userId: invitedUserId,
            canView: perm.canView,
            canEdit: perm.canEdit,
            canShare: perm.canShare,
            canDelete: false, // Never grant delete via invite
            grantedBy: user.id,
          })
          .returning();
      }
    });

    const results = await Promise.all(permissionPromises);
    const validResults = results.filter(r => r !== null);

    // Send notification to added user
    await createDriveNotification(
      invitedUserId,
      driveId,
      'invited', // Always use 'invited' which now has "added" language
      role,
      user.id
    );

    return NextResponse.json({
      memberId,
      permissionsGranted: validResults.length,
      message: `User added with ${validResults.length} page permissions`,
    });
  } catch (error) {
    loggers.api.error('Error adding member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}