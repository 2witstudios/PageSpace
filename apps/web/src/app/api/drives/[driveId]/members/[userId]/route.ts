import { NextResponse } from 'next/server';
import { db, eq, and } from '@pagespace/db';
import { drives, driveMembers, users, userProfiles, pagePermissions, pages } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createDriveNotification } from '@pagespace/lib';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const currentUserId = auth.userId;

    const { driveId, userId } = await context.params;

    // Get drive and check ownership
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive[0].ownerId === currentUserId;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, currentUserId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Get member details with profile
    const memberData = await db.select({
      id: driveMembers.id,
      userId: driveMembers.userId,
      role: driveMembers.role,
      customRoleId: driveMembers.customRoleId,
      invitedAt: driveMembers.invitedAt,
      acceptedAt: driveMembers.acceptedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
      },
      profile: {
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      }
    })
    .from(driveMembers)
    .leftJoin(users, eq(driveMembers.userId, users.id))
    .leftJoin(userProfiles, eq(driveMembers.userId, userProfiles.userId))
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId)
    ))
    .limit(1);

    if (memberData.length === 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const member = {
      ...memberData[0],
      drive: {
        id: driveId,
        name: drive[0].name,
        slug: drive[0].slug,
        ownerId: drive[0].ownerId,
      }
    };

    // Get current permissions for this member
    const permissions = await db.select({
      pageId: pagePermissions.pageId,
      canView: pagePermissions.canView,
      canEdit: pagePermissions.canEdit,
      canShare: pagePermissions.canShare,
    })
    .from(pagePermissions)
    .innerJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId)
    ));

    return NextResponse.json({ 
      member,
      permissions
    });
  } catch (error) {
    loggers.api.error('Error fetching member details:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch member details' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const currentUserId = auth.userId;

    const { driveId, userId } = await context.params;

    const body = await request.json();
    const { role, customRoleId, permissions } = body;

    if (!permissions || !Array.isArray(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions data' }, { status: 400 });
    }

    if (role && !['MEMBER', 'ADMIN'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // Get drive and check ownership
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive[0].ownerId === currentUserId;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, currentUserId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Verify member exists in drive
    const member = await db.select()
      .from(driveMembers)
      .where(and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId)
      ))
      .limit(1);

    if (member.length === 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Update role and customRoleId if provided
    const oldRole = member[0].role;
    const updateData: { role?: 'OWNER' | 'ADMIN' | 'MEMBER'; customRoleId?: string | null } = {};
    if (role && ['OWNER', 'ADMIN', 'MEMBER'].includes(role)) {
      updateData.role = role as 'OWNER' | 'ADMIN' | 'MEMBER';
    }
    if (customRoleId !== undefined) {
      updateData.customRoleId = customRoleId || null;
    }

    if (Object.keys(updateData).length > 0) {
      await db.update(driveMembers)
        .set(updateData)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId)
        ));
    }

    // Send notification if role changed
    if (role && role !== oldRole) {
      await createDriveNotification(
        userId,
        driveId,
        'role_changed',
        role,
        currentUserId
      );

      // Broadcast role change event to the affected user
      await broadcastDriveMemberEvent(
        createDriveMemberEventPayload(driveId, userId, 'member_role_changed', {
          role,
          driveName: drive[0].name
        })
      );
    }

    // Get all pages in the drive to validate pageIds
    const drivePages = await db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));

    const validPageIds = new Set(drivePages.map(p => p.id));

    // Delete all existing permissions for this user in this drive
    const existingPermissions = await db.select({ pageId: pagePermissions.pageId })
      .from(pagePermissions)
      .innerJoin(pages, eq(pagePermissions.pageId, pages.id))
      .where(and(
        eq(pagePermissions.userId, userId),
        eq(pages.driveId, driveId)
      ));

    // Delete permissions for pages in this drive (can't join in delete, so delete by pageId)
    for (const perm of existingPermissions) {
      await db.delete(pagePermissions)
        .where(and(
          eq(pagePermissions.userId, userId),
          eq(pagePermissions.pageId, perm.pageId)
        ));
    }

    // Insert new permissions
    const newPermissions = permissions
      .filter(p => validPageIds.has(p.pageId))
      .filter(p => p.canView || p.canEdit || p.canShare) // Only insert if at least one permission is true
      .map(p => ({
        pageId: p.pageId,
        userId: userId,
        canView: p.canView || false,
        canEdit: p.canEdit || false,
        canShare: p.canShare || false,
        grantedBy: currentUserId,
        grantedAt: new Date(),
      }));

    if (newPermissions.length > 0) {
      await db.insert(pagePermissions).values(newPermissions);
    }

    return NextResponse.json({ 
      success: true,
      message: 'Permissions updated successfully',
      permissionsUpdated: newPermissions.length
    });
  } catch (error) {
    loggers.api.error('Error updating member permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update member permissions' },
      { status: 500 }
    );
  }
}