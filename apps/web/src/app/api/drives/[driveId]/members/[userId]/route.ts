import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  loggers,
  checkDriveAccess,
  getDriveMemberDetails,
  getMemberPermissions,
  updateMemberRole,
  updateMemberPermissions,
} from '@pagespace/lib/server';
import { createDriveNotification } from '@pagespace/lib';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';

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

    // Check if user is owner or admin
    const access = await checkDriveAccess(driveId, currentUserId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Get member details
    const memberData = await getDriveMemberDetails(driveId, userId);

    if (!memberData) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const member = {
      ...memberData,
      drive: {
        id: driveId,
        name: access.drive.name,
        slug: access.drive.slug,
        ownerId: access.drive.ownerId,
      }
    };

    // Get current permissions for this member
    const permissions = await getMemberPermissions(driveId, userId);

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

    // Check if user is owner or admin
    const access = await checkDriveAccess(driveId, currentUserId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Verify member exists in drive
    const memberData = await getDriveMemberDetails(driveId, userId);

    if (!memberData) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Update role and customRoleId if provided
    const { oldRole } = await updateMemberRole(driveId, userId, role, customRoleId);

    // Send notification if role changed (boundary obligation)
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
          driveName: access.drive.name
        })
      );

      // Log activity for audit trail (role change is a critical security event)
      const actorInfo = await getActorInfo(currentUserId);
      logMemberActivity(currentUserId, 'member_role_change', {
        driveId,
        driveName: access.drive.name,
        targetUserId: userId,
        targetUserEmail: memberData.email,
        role: role as string,
        previousRole: oldRole as string,
      }, actorInfo);
    }

    // Update permissions
    const permissionsUpdated = await updateMemberPermissions(
      driveId,
      userId,
      currentUserId,
      permissions
    );

    return NextResponse.json({
      success: true,
      message: 'Permissions updated successfully',
      permissionsUpdated
    });
  } catch (error) {
    loggers.api.error('Error updating member permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update member permissions' },
      { status: 500 }
    );
  }
}
