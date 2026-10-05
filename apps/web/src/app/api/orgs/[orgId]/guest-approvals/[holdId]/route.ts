import { NextResponse } from 'next/server';
import type { OrgApiErrorCode } from '@pagespace/lib/organizations/api-error-codes';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { recordOrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { GUESTS_OFF_MESSAGE } from '@pagespace/lib/organizations/sharing-decisions';
import { claimPendingGuestApproval, markApprovedInvitation, requestGuestApproval, type ClaimedGuestApproval } from '@pagespace/lib/permissions/guest-holds';
import { createPermissionNotification } from '@pagespace/lib/notifications/notifications';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { db } from '@pagespace/db/db';
import { completeApprovedLinkAdmission } from '@pagespace/lib/permissions/share-link-service';
import { completeApprovedPageGrant } from '@pagespace/lib/permissions/page-grant-admission';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { sendPendingPageInvite } from '@/lib/page-invites/share-invite-handlers';
import type { PendingPagePermission } from '@pagespace/db/schema/pending-page-invites';
import { emitAcceptanceSideEffects, type AcceptedInviteData } from '@pagespace/lib/services/invites';
import { buildAcceptancePorts } from '@/lib/auth/invite-acceptance-adapters';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { handleEmailPath, handleUserIdPath } from '@/lib/drive-invites/invite-handlers';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string; holdId: string }> };

const decisionSchema = z.object({ decision: z.enum(['approve', 'decline']) });

const PAGE_GRANT_REFUSALS = {
  NOT_A_PAGE_GRANT: 'This request cannot be approved.',
  PAGE_GONE: 'The page this person was asked onto no longer exists, so there is nothing to approve.',
  POLICY_OFF: GUESTS_OFF_MESSAGE,
} as const;

/** The machine codes of PAGE_GRANT_REFUSALS: the one {error, code} convention (UI-7), never `reason`. */
const PAGE_GRANT_REFUSAL_CODES = {
  NOT_A_PAGE_GRANT: 'not_a_page_grant',
  PAGE_GONE: 'page_gone',
  POLICY_OFF: 'org_policy',
} as const satisfies Record<keyof typeof PAGE_GRANT_REFUSALS, OrgApiErrorCode>;

/** The flags of a queued page grant, back in the share-invite's terms. */
const invitePermissions = (p: { canView: boolean; canEdit: boolean; canShare: boolean }): PendingPagePermission[] => [
  ...(p.canView ? ['VIEW' as const] : []),
  ...(p.canEdit ? ['EDIT' as const] : []),
  ...(p.canShare ? ['SHARE' as const] : []),
];

const LINK_REFUSALS = {
  NOT_A_LINK_REQUEST: 'This request cannot be approved.',
  LINK_GONE: 'The share link this person used no longer exists or has been turned off, so there is nothing to approve.',
  POLICY_OFF: GUESTS_OFF_MESSAGE,
} as const;

/** The machine code of each refusal (api-error-codes): snake_case, the convention of every org route. */
const LINK_REFUSAL_CODES = {
  NOT_A_LINK_REQUEST: 'not_a_link_request',
  LINK_GONE: 'link_gone',
  POLICY_OFF: 'org_policy',
} as const satisfies Record<keyof typeof LINK_REFUSALS, OrgApiErrorCode>;

/** Put a request back on the queue when approving it failed for a reason that is not the approver's. */
async function requeue(claim: ClaimedGuestApproval): Promise<void> {
  await requestGuestApproval({
    orgId: claim.orgId,
    driveId: claim.driveId,
    ...(claim.userId ? { userId: claim.userId } : { email: claim.email ?? undefined }),
    origin: claim.origin,
    request: claim.request,
    requestedBy: claim.requestedBy,
  });
}

const audit = (claim: ClaimedGuestApproval, eventType: 'org.guest.approved' | 'org.guest.declined', actorId: string) =>
  recordOrgAuditEvent({
    orgId: claim.orgId,
    eventType,
    actorId,
    resourceType: 'drive',
    resourceId: claim.driveId,
    driveId: claim.driveId,
    details: { holdId: claim.holdId, origin: claim.origin, target: claim.userId ? 'user' : 'email', ...(claim.userId ? { targetUserId: claim.userId } : {}) },
  }).catch((error) => loggers.api.error('Guest decision made but its audit event was not recorded', error as Error));

/**
 * POST /api/orgs/[orgId]/guest-approvals/[holdId] (Spec POL-2) — an Owner or Admin approves or declines a queued
 * guest. Approving admits them through the SAME code the original action would have run (the invite handlers, or the
 * link redemption), so an approved guest gets exactly what an immediate one would. A request of another org, one
 * already decided, or one that does not exist all answer the same 404.
 */
export async function POST(request: Request, context: Context) {
  const { orgId, holdId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues, code: 'invalid_request' }, { status: 400 });

    // Approving while guests are OFF would admit someone the policy forbids: refuse before touching the queue.
    if (parsed.data.decision === 'approve' && (await getOrgPolicies(orgId)).guests === 'off') {
      return NextResponse.json({ error: GUESTS_OFF_MESSAGE, code: 'org_policy', policy: 'guests' }, { status: 403 });
    }

    const claim = await claimPendingGuestApproval({ orgId, holdId });
    if (!claim) return NextResponse.json({ error: 'Request not found', code: 'not_found' }, { status: 404 });

    if (parsed.data.decision === 'decline') {
      await audit(claim, 'org.guest.declined', gate.userId);
      return NextResponse.json({ decided: 'declined' });
    }

    if (claim.origin === 'invite') {
      const drive = await driveInviteRepository.findDriveById(claim.driveId);
      if (!drive) return NextResponse.json({ error: 'Request not found', code: 'not_found' }, { status: 404 });
      const req = claim.request;
      const inviterUserId = req.invitedBy ?? gate.userId;
      const role = req.role ?? 'MEMBER';
      const permissions = req.permissions ?? [];
      const summary = { id: drive.id, name: drive.name, ownerId: drive.ownerId };
      const response = claim.userId
        ? await handleUserIdPath({ request, body: { userId: claim.userId, role, customRoleId: req.customRoleId ?? null, permissions }, drive: summary, driveId: claim.driveId, inviterUserId, skipGuestPolicy: true })
        : await handleEmailPath({ request, body: { email: claim.email ?? '', role, customRoleId: req.customRoleId ?? null, permissions, expiryDays: req.expiryDays ?? null }, drive: summary, driveId: claim.driveId, inviterUserId, skipGuestPolicy: true });
      if (!response.ok) {
        // The invite could not be carried out (an address that has since been invited, a suspended account, ...).
        // The request goes back on the queue rather than vanishing, and the approver is told why.
        await requeue(claim);
        return response;
      }
      const result = await response.json().catch(() => null) as { kind?: string; memberId?: string } | null;
      // An emailed invitation is admitted later, at its acceptance: remember that THIS invitation (the pending
      // invite the email path just stored, returned as `memberId`) was approved, so its acceptance does not ask again.
      // Any other invitation to the same address is queued there instead.
      if (!claim.userId && claim.email && result?.kind === 'invited' && result.memberId) {
        await markApprovedInvitation(db, { orgId, driveId: claim.driveId, email: claim.email, approvedBy: gate.userId, invite: { kind: 'drive', id: result.memberId } });
      }
      await audit(claim, 'org.guest.approved', gate.userId);
      return NextResponse.json({ decided: 'approved', result });
    }

    if (claim.origin === 'page_grant') {
      const granted = await completeApprovedPageGrant(claim);
      if (!granted.ok) {
        // Guests turned OFF between the check above and the grant's own locked re-check: the request is not the
        // approver's fault and must not vanish, so it goes back on the queue (it can be approved once allowed again).
        if (granted.error === 'POLICY_OFF') await requeue(claim);
        return NextResponse.json({ error: PAGE_GRANT_REFUSALS[granted.error], code: PAGE_GRANT_REFUSAL_CODES[granted.error] }, { status: 409 });
      }
      // The same after-effects as an immediate grant: the person is told, and open clients refresh the pages.
      const permissions = claim.request.permissions ?? [];
      for (const pageId of granted.pageIds) {
        const p = permissions.find((x) => x.pageId === pageId);
        if (p) {
          await createPermissionNotification(granted.userId, pageId, 'granted', { canView: p.canView, canEdit: p.canEdit, canShare: p.canShare, canDelete: p.canDelete ?? false }, claim.request.invitedBy ?? gate.userId)
            .catch((error: unknown) => loggers.api.error('Page grant approved; notification failed', error as Error));
        }
        broadcastPageEvent(createPageEventPayload(granted.driveId, pageId, 'updated'))
          .catch((error: Error) => loggers.api.error('Page grant approved; broadcast failed', error));
      }
      await audit(claim, 'org.guest.approved', gate.userId);
      return NextResponse.json({ decided: 'approved', driveId: granted.driveId, pageIds: granted.pageIds });
    }

    if (claim.origin === 'page_invite') {
      const req = claim.request;
      const asked = req.permissions?.[0];
      const page = req.pageId ? await pageInviteRepository.findPageById(req.pageId) : null;
      if (!page || page.driveId !== claim.driveId || !asked || !claim.email) {
        return NextResponse.json({ error: PAGE_GRANT_REFUSALS.PAGE_GONE, code: PAGE_GRANT_REFUSAL_CODES.PAGE_GONE }, { status: 409 });
      }
      const response = await sendPendingPageInvite({
        request,
        page,
        email: claim.email,
        permissions: invitePermissions(asked),
        expiryDays: req.expiryDays ?? null,
        inviterUserId: req.invitedBy ?? gate.userId,
      });
      if (!response.ok) {
        await requeue(claim);
        return response;
      }
      const result = await response.json().catch(() => null) as { kind?: string; inviteId?: string } | null;
      if (result?.kind === 'invited' && result.inviteId) {
        await markApprovedInvitation(db, { orgId, driveId: claim.driveId, email: claim.email, approvedBy: gate.userId, invite: { kind: 'page', id: result.inviteId } });
      }
      await audit(claim, 'org.guest.approved', gate.userId);
      return NextResponse.json({ decided: 'approved', result });
    }

    const admitted = await completeApprovedLinkAdmission(claim);
    if (!admitted.ok) {
      return NextResponse.json({ error: LINK_REFUSALS[admitted.error], code: LINK_REFUSAL_CODES[admitted.error] }, { status: 409 });
    }
    if (admitted.memberId && admitted.role !== 'GUEST') {
      const ports = buildAcceptancePorts(request);
      const data: AcceptedInviteData = {
        memberId: admitted.memberId,
        driveId: admitted.driveId,
        driveName: admitted.driveName,
        role: admitted.role,
        customRoleId: admitted.customRoleId,
        invitedUserId: admitted.userId,
        inviterUserId: admitted.createdBy ?? gate.userId,
      };
      await emitAcceptanceSideEffects(ports, data, 0).catch((error) => loggers.api.error('Guest approved; side effects failed', error as Error));
    }
    await audit(claim, 'org.guest.approved', gate.userId);
    return NextResponse.json({ decided: 'approved', driveId: admitted.driveId });
  } catch (error) {
    loggers.api.error('Error deciding a guest approval:', error as Error);
    return NextResponse.json({ error: 'Failed to decide the request', code: 'internal_error' }, { status: 500 });
  }
}
