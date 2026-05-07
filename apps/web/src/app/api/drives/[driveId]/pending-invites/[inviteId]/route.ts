import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { revokePendingInvite } from '@pagespace/lib/services/invites';
import { buildRevokePorts } from '@/lib/auth/revoke-adapters';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * Revoke a pending drive invite. Authorization (accepted OWNER/ADMIN of the
 * drive) lives in the pure-core `validateRevokeRequest`; this handler just
 * builds adapter ports and maps result codes to HTTP.
 *
 * NOT_FOUND is returned when the invite does not exist OR exists on a
 * different drive — never disclose the cross-drive existence to a wrong-drive
 * admin (that would let a non-OWNER/ADMIN of any drive enumerate invite IDs).
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; inviteId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const { driveId, inviteId } = await context.params;

    const result = await revokePendingInvite(buildRevokePorts(request))({
      inviteId,
      driveId,
      actorId: auth.userId,
    });

    if (!result.ok) {
      if (result.error === 'NOT_FOUND') {
        return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
      }
      // FORBIDDEN — actor is not an accepted OWNER/ADMIN of this drive.
      // Adapter's auditPermissionRevoked fires only on success; audit the
      // denied attempt explicitly here so a malicious enumeration leaves a
      // trail.
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: auth.userId,
        riskScore: 0.4,
        resourceType: 'drive',
        resourceId: driveId,
        details: { operation: 'revoke_invite', inviteId },
      });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Success-side audit (authz.permission.revoked) is emitted by the
    // adapter's auditPermissionRevoked port inside the pipe.
    return NextResponse.json({
      inviteId: result.data.inviteId,
      driveId: result.data.driveId,
    });
  } catch (error) {
    loggers.api.error('Error revoking pending invite:', error as Error);
    return NextResponse.json(
      { error: 'Failed to revoke invite' },
      { status: 500 },
    );
  }
}
