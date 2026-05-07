import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

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

    // Pending invites are visible to OWNER/ADMIN only. The field is always an
    // array (never undefined) so client-side SWR cache shape stays stable as
    // a viewer's role changes — avoids "field present for some users, missing
    // for others" type ambiguity in the UI.
    const canSeePending = access.isOwner || access.isAdmin;
    const pendingInvites = canSeePending
      ? await driveInviteRepository.findUnconsumedInvitesByDrive(driveId)
      : [];

    return NextResponse.json({
      members,
      pendingInvites,
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

