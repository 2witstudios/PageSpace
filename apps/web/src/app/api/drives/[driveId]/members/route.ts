import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  loggers,
  checkDriveAccess,
  listDriveMembers,
  isMemberOfDrive,
  addDriveMember,
} from '@pagespace/lib/server';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user has access to this drive
    const access = await checkDriveAccess(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isMember) {
      return NextResponse.json({ error: 'You must be a drive member to view members' }, { status: 403 });
    }

    // Get all members with their profiles and permission counts
    const members = await listDriveMembers(driveId);

    return NextResponse.json({
      members,
      currentUserRole: access.isOwner ? 'OWNER' : (access.isAdmin ? 'ADMIN' : 'MEMBER')
    });
  } catch (error) {
    loggers.api.error('Error fetching drive members:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch members' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    const body = await request.json();
    const { userId: invitedUserId, role = 'MEMBER' } = body;

    // Check if user is drive owner
    const access = await checkDriveAccess(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner) {
      return NextResponse.json({ error: 'Only drive owner can add members' }, { status: 403 });
    }

    // Check if member already exists
    const alreadyMember = await isMemberOfDrive(driveId, invitedUserId);

    if (alreadyMember) {
      return NextResponse.json({ error: 'User is already a member' }, { status: 400 });
    }

    // Add member
    const newMember = await addDriveMember(driveId, userId, {
      userId: invitedUserId,
      role: role as 'ADMIN' | 'MEMBER',
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logMemberActivity(userId, 'member_add', {
      driveId,
      driveName: access.drive.name,
      targetUserId: invitedUserId,
      role: role as string,
    }, actorInfo);

    return NextResponse.json({ member: newMember });
  } catch (error) {
    loggers.api.error('Error adding drive member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}
