/**
 * The page share-invite steps the route and the approval of a queued guest (POL-2) both run, as plain functions so
 * an approved guest gets exactly what an immediate one would. Route files can only export route handlers, which is
 * why they live here.
 */
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingPageShareInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { decideOrgDriveAdmission } from '@pagespace/lib/permissions/guest-admission';
import { requestGuestApproval } from '@pagespace/lib/permissions/guest-holds';
import { GUESTS_HELD_MESSAGE, guestsOffRefusal } from '@pagespace/lib/organizations/sharing-decisions';
import { recordOrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import type { PendingPagePermission } from '@pagespace/db/schema/pending-page-invites';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';

export interface SharedPage {
  id: string;
  title: string;
  driveId: string;
  driveName: string;
}

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

const pageFlags = (permissions: PendingPagePermission[]) => ({
  canView: permissions.includes('VIEW'),
  canEdit: permissions.includes('EDIT'),
  canShare: permissions.includes('SHARE'),
});

/**
 * POL-2 for a page share-invite. Null means "go ahead". Off answers 403 naming the policy; approve queues the
 * request for an Owner or Admin and answers 202 with nothing granted and nothing sent. An existing verified account
 * is decided with its id and queued as a direct page grant; an address with no verified account can only be an
 * outsider and is queued by email, to be invited when approved.
 */
export async function pageShareGuestPolicyResponse(input: {
  page: SharedPage;
  email: string;
  verifiedUserId: string | null;
  permissions: PendingPagePermission[];
  expiryDays: number | null;
  inviterUserId: string;
}): Promise<Response | null> {
  const { page, email, verifiedUserId, permissions, expiryDays, inviterUserId } = input;
  const admission = await decideOrgDriveAdmission({ driveId: page.driveId, userId: verifiedUserId });
  if (admission.decision === 'allow') return null;
  if (admission.decision === 'refuse') {
    const refusal = guestsOffRefusal();
    return NextResponse.json({ error: refusal.message, code: refusal.code, policy: refusal.policy }, { status: refusal.status });
  }
  if (!admission.orgId) return null;
  const grant = { pageId: page.id, ...pageFlags(permissions) };
  const item = verifiedUserId
    ? await requestGuestApproval({
      orgId: admission.orgId,
      driveId: page.driveId,
      userId: verifiedUserId,
      origin: 'page_grant',
      request: { permissions: [grant], invitedBy: inviterUserId },
      requestedBy: inviterUserId,
    })
    : await requestGuestApproval({
      orgId: admission.orgId,
      driveId: page.driveId,
      email,
      origin: 'page_invite',
      request: { pageId: page.id, permissions: [grant], expiryDays, invitedBy: inviterUserId },
      requestedBy: inviterUserId,
    });
  await recordOrgAuditEvent({
    orgId: admission.orgId,
    eventType: 'org.guest.requested',
    actorId: inviterUserId,
    resourceType: 'drive',
    resourceId: page.driveId,
    driveId: page.driveId,
    details: { holdId: item.holdId, origin: item.origin, target: verifiedUserId ? 'user' : 'email' },
  }).catch((error) => loggers.api.error('Page share queued but its audit event was not recorded', error as Error));
  return NextResponse.json({ kind: 'pending_approval', holdId: item.holdId, message: GUESTS_HELD_MESSAGE }, { status: 202 });
}

/**
 * Invite an address that has no verified account to a page: store a pending invite and email its link. A failed
 * email removes the row again so the address can be re-invited.
 */
export async function sendPendingPageInvite(args: {
  request: Request;
  page: SharedPage;
  email: string;
  permissions: PendingPagePermission[];
  expiryDays: number | null;
  inviterUserId: string;
}): Promise<Response> {
  const { request, page, email, permissions, expiryDays, inviterUserId } = args;
  const pageId = page.id;
  const now = new Date();

  const activePending = await pageInviteRepository.findActivePendingInviteByPageAndEmail(pageId, email, now);
  if (activePending) {
    return NextResponse.json(
      { error: 'An invitation is already pending for this email.', existingInviteId: activePending.id },
      { status: 409 },
    );
  }

  const appUrl = resolveAppUrl();
  if (!appUrl) {
    loggers.api.error('Page share invite email cannot be sent: WEB_APP_URL and NEXT_PUBLIC_APP_URL both unset');
    return NextResponse.json({ error: 'Email delivery is not configured on this deployment.' }, { status: 500 });
  }

  const { token, tokenHash, expiresAt } = createInviteToken({
    now,
    expiryMinutes: expiryDays ? expiryDays * 24 * 60 : null,
  });

  let pendingInvite: { id: string };
  try {
    pendingInvite = await pageInviteRepository.createPendingInvite({
      tokenHash,
      email,
      pageId,
      permissions,
      invitedBy: inviterUserId,
      expiresAt,
      now,
    });
  } catch (insertError) {
    const message = insertError instanceof Error ? insertError.message : String(insertError);
    const isUniqueViolation =
      message.includes('pending_page_invites_active_page_email_idx') ||
      message.includes('pending_page_invites_token_hash_unique') ||
      message.includes('duplicate key');
    if (isUniqueViolation) {
      return NextResponse.json({ error: 'An invitation is already pending for this email.' }, { status: 409 });
    }
    loggers.api.error(
      'Failed to persist pending page invite',
      insertError instanceof Error ? insertError : new Error(String(insertError)),
      { pageId },
    );
    return NextResponse.json({ error: 'Failed to send invite' }, { status: 500 });
  }

  const inviter = await pageInviteRepository.findInviterDisplay(inviterUserId);
  const inviteUrl = `${appUrl}/invite/${encodeURIComponent(token)}`;

  // R6: SMTP failure → compensating delete so the partial unique index stays clean
  try {
    await sendPendingPageShareInvitationEmail({
      recipientEmail: email,
      inviterName: inviter?.name ?? 'A teammate',
      pageTitle: page.title,
      driveName: page.driveName,
      permissions: permissions.map((p) => p.toLowerCase()),
      inviteUrl,
    });
  } catch (emailError) {
    loggers.api.error(
      'Failed to send pending page share invitation email; rolling back pending invite row',
      emailError instanceof Error ? emailError : new Error(String(emailError)),
      { pageId, recipientEmail: email },
    );
    try {
      await pageInviteRepository.deletePendingInvite(pendingInvite.id);
    } catch (rollbackError) {
      loggers.api.error(
        'Rollback of pending_page_invites row failed after email send failure',
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        { inviteId: pendingInvite.id, pageId },
      );
    }
    return NextResponse.json({ error: 'Failed to send invitation email. Please try again.' }, { status: 502 });
  }

  trackPageOperation(inviterUserId, 'share', pageId, {
    invitedEmail: email,
    permissions,
    pending: true,
  });

  auditRequest(request, {
    eventType: 'authz.permission.granted',
    userId: inviterUserId,
    resourceType: 'page',
    resourceId: pageId,
    details: { targetEmail: email, permissions, operation: 'share_invite', pending: true },
  });

  return NextResponse.json({
    kind: 'invited',
    inviteId: pendingInvite.id,
    email,
    message: `Invitation sent to ${email}`,
  });
}
