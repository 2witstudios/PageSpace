import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { checkDriveAccess, listDriveMembers, getDriveOwnerAsMember } from '@pagespace/lib/services/drive-member-service';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Scope check: scoped MCP tokens must have explicit membership in this drive
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    // Check if user has access to this drive
    const access = await checkDriveAccess(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isMember) {
      return NextResponse.json({ error: 'You must be a drive member to view members' }, { status: 403 });
    }

    // Get all members with their profiles and permission counts. The owner
    // is never a drive_members row (ownership lives on drives.ownerId), so
    // prepend it explicitly; unaccepted invitees are pending, not members.
    const [rawMembers, ownerMember] = await Promise.all([
      listDriveMembers(driveId),
      getDriveOwnerAsMember(driveId),
    ]);
    const acceptedMembers = rawMembers.filter(
      (m) => m.acceptedAt !== null && m.userId !== ownerMember?.userId
    );
    const members = ownerMember ? [ownerMember, ...acceptedMembers] : acceptedMembers;

    // Pending invites are visible to OWNER/ADMIN only. The field is always an
    // array (never undefined) so client-side SWR cache shape stays stable as
    // a viewer's role changes — avoids "field present for some users, missing
    // for others" type ambiguity in the UI.
    const canSeePending = await isPrincipalDriveOwnerOrAdmin(auth, driveId);
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

