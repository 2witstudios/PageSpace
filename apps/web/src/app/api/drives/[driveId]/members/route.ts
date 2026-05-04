import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';

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

// POST handler intentionally removed.
// `/api/drives/[driveId]/members/invite` is the canonical add-member entry point — it
// enforces email-verified inviter, owner OR admin authorization, per-drive + per-email
// rate limits, the email-vs-userId payload branch with pending-state handling, and
// the member_added fan-out broadcast. The legacy POST here had none of those gates and
// auto-accepted the new row, which subverted the invitation acceptance design.
