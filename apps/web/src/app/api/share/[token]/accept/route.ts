import { NextResponse } from 'next/server';
import { authenticateWithEnforcedContext, isEnforcedAuthError, getClientIP } from '@/lib/auth';
import {
  redeemDriveShareLink,
  redeemPageShareLink,
} from '@pagespace/lib/permissions/share-link-service';
import { securityAudit } from '@pagespace/lib/audit/security-audit';
import { buildAcceptancePorts } from '@/lib/auth/invite-acceptance-adapters';
import { emitAcceptanceSideEffects } from '@pagespace/lib/services/invites';
import type { AcceptedInviteData } from '@pagespace/lib/services/invites';

const AUTH_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const auth = await authenticateWithEnforcedContext(request, AUTH_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;

  const { token } = await context.params;
  const clientIP = getClientIP(request);

  const driveResult = await redeemDriveShareLink(auth.ctx, token);

  if (driveResult.ok) {
    await securityAudit.logDataAccess(auth.ctx.userId, 'write', 'drive', driveResult.data.driveId, {
      action: 'share_link_redeem',
      linkId: driveResult.data.linkId,
      ipAddress: clientIP,
    }).catch(() => undefined);
    const ports = buildAcceptancePorts(request);
    const acceptData: AcceptedInviteData = {
      memberId: driveResult.data.memberId,
      driveId: driveResult.data.driveId,
      driveName: driveResult.data.driveName,
      role: driveResult.data.role,
      invitedUserId: auth.ctx.userId,
      inviterUserId: auth.ctx.userId,
    };
    await emitAcceptanceSideEffects(ports, acceptData, 0);
    return NextResponse.json({ type: 'drive', driveId: driveResult.data.driveId });
  }

  if (driveResult.error === 'ALREADY_MEMBER') {
    return NextResponse.json({ type: 'drive', driveId: driveResult.driveId });
  }

  if (driveResult.error !== 'NOT_FOUND') {
    return NextResponse.json({ error: 'Failed to redeem share link' }, { status: 500 });
  }

  const pageResult = await redeemPageShareLink(auth.ctx, token);

  if (pageResult.ok) {
    await securityAudit.logDataAccess(auth.ctx.userId, 'write', 'page', pageResult.data.pageId, {
      action: 'share_link_redeem',
      linkId: pageResult.data.linkId,
      ipAddress: clientIP,
    }).catch(() => undefined);
    return NextResponse.json({
      type: 'page',
      pageId: pageResult.data.pageId,
      driveId: pageResult.data.driveId,
    });
  }

  if (pageResult.error === 'NOT_FOUND') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ error: 'Failed to redeem share link' }, { status: 500 });
}
