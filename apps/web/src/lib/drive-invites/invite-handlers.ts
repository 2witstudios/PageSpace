/**
 * The two ways a person is added to a drive from the invite route, as plain functions so the route and the approval
 * of a queued guest (POL-2) run exactly the same code: adding an existing user (handleUserIdPath) and inviting an
 * address (handleEmailPath). Route files can only export route handlers, which is why they live here.
 */
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { emitAcceptanceSideEffects, type AcceptedInviteData } from '@pagespace/lib/services/invites';
import { buildAcceptancePorts } from '@/lib/auth/invite-acceptance-adapters';
import { isGuestRole } from '@pagespace/lib/permissions/guest-role';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { decideOrgDriveAdmission } from '@pagespace/lib/permissions/guest-admission';
import { requestGuestApproval } from '@pagespace/lib/permissions/guest-holds';
import { GUESTS_HELD_MESSAGE, guestsOffRefusal, type GuestAdmissionRefusal } from '@pagespace/lib/organizations/sharing-decisions';
import { ORG_LAPSED_REFUSAL } from '@pagespace/lib/organizations/status-core';
import { recordOrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import type { GuestHoldRequest } from '@pagespace/db/schema/org-guest-holds';

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

/**
 * Why an outsider was not added, as the route answers it: the guests policy names itself (403 org_policy); a lapsed
 * org answers with the lapse refusal (402 org_lapsed), since nothing about the policy stopped it ([D-OW-33]).
 */
export function admissionRefusalResponse(refusal: GuestAdmissionRefusal): Response {
  if (refusal === 'org_lapsed') {
    return NextResponse.json({ error: ORG_LAPSED_REFUSAL.message, code: ORG_LAPSED_REFUSAL.code }, { status: ORG_LAPSED_REFUSAL.status });
  }
  const policy = guestsOffRefusal();
  return NextResponse.json({ error: policy.message, code: policy.code, policy: policy.policy }, { status: policy.status });
}

/**
 * POL-2 for the invite paths. Null means "go ahead". Off answers 403 naming the policy; approve queues the request
 * for an Owner or Admin and answers 202 with nothing granted and nothing sent.
 */
async function guestPolicyResponse(input: {
  driveId: string;
  userId?: string;
  email?: string;
  hold: { origin: 'invite'; request: GuestHoldRequest };
  requestedBy: string;
}): Promise<Response | null> {
  const admission = await decideOrgDriveAdmission({ driveId: input.driveId, userId: input.userId ?? null });
  if (admission.decision === 'allow') return null;
  if (admission.decision === 'refuse') return admissionRefusalResponse(admission.refusal);
  if (!admission.orgId) return null;
  const item = await requestGuestApproval({
    orgId: admission.orgId,
    driveId: input.driveId,
    ...(input.userId ? { userId: input.userId } : { email: input.email }),
    origin: input.hold.origin,
    request: input.hold.request,
    requestedBy: input.requestedBy,
  });
  await recordOrgAuditEvent({
    orgId: admission.orgId,
    eventType: 'org.guest.requested',
    actorId: input.requestedBy,
    resourceType: 'drive',
    resourceId: input.driveId,
    driveId: input.driveId,
    details: { holdId: item.holdId, origin: input.hold.origin, target: input.userId ? 'user' : 'email' },
  }).catch((error) => loggers.api.error('Guest request queued but its audit event was not recorded', error as Error));
  return NextResponse.json(
    { kind: 'pending_approval', holdId: item.holdId, message: GUESTS_HELD_MESSAGE },
    { status: 202 },
  );
}

export interface DriveSummary {
  id: string;
  name: string;
  ownerId: string;
}

export interface UserIdBody {
  userId: string;
  role: 'MEMBER' | 'ADMIN';
  customRoleId?: string | null;
  permissions: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }>;
}

export interface EmailBody {
  email: string;
  role: 'MEMBER' | 'ADMIN';
  customRoleId?: string | null;
  permissions: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }>;
  expiryDays?: number | null;
}

export async function handleUserIdPath(args: {
  request: Request;
  body: UserIdBody;
  drive: DriveSummary;
  driveId: string;
  inviterUserId: string;
  // Set when we arrived here via an email-payload fall-through. Lets the
  // audit trail record the original email selector even after lookup.
  sourceEmail?: string;
  // Set when the email path has already validated the target's verification
  // status. Skips the redundant lookup and prevents the verified-existing-user
  // shortcut from infinite-recursing through the gate added below.
  skipVerificationCheck?: boolean;
  // Set ONLY when an Owner or Admin approved this guest from the queue (POL-2): the guests policy was applied when
  // the request was made, so replaying it must not queue it again.
  skipGuestPolicy?: boolean;
}): Promise<Response> {
  const { request, body, drive, driveId, inviterUserId, sourceEmail, skipVerificationCheck, skipGuestPolicy } = args;
  const { userId: invitedUserId, role, customRoleId, permissions } = body;

  // Review C1: a never-authenticated user (emailVerified IS NULL) must not be
  // auto-accepted into a drive. Route them through the invitation flow so they
  // explicitly consent via magic-link click. Suspended users are refused
  // outright. Missing user → 404 since the userId came from a client-supplied
  // selector and a stale userId should not silently create membership.
  if (!skipVerificationCheck) {
    const targetStatus = await driveInviteRepository.findUserVerificationStatusById(invitedUserId);
    if (!targetStatus) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (targetStatus.suspendedAt) {
      return NextResponse.json(
        { error: 'This account is suspended and cannot be invited.' },
        { status: 403 }
      );
    }
    if (!targetStatus.emailVerified) {
      // Forward the caller-supplied permissions verbatim. The email path
      // returns 422 when `permissions.length > 0` for not-yet-registered
      // targets — that's the correct behavior here too. Hardcoding `[]`
      // would silently drop the permissions and return kind:invited,
      // misleading admins into thinking page-level grants applied.
      return await handleEmailPath({
        request,
        body: {
          email: targetStatus.email,
          role,
          customRoleId: customRoleId ?? null,
          permissions,
        },
        drive,
        driveId,
        inviterUserId,
        skipGuestPolicy,
      });
    }
  }

  if (customRoleId && role !== 'ADMIN') {
    const roleExists = await db
      .select({ id: driveRoles.id })
      .from(driveRoles)
      .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
      .limit(1);
    if (roleExists.length === 0) {
      return NextResponse.json({ error: 'Custom role not found in this drive' }, { status: 400 });
    }
  }

  const validPageIds = new Set(await driveInviteRepository.getValidPageIds(driveId));
  const existingMember = await driveInviteRepository.findExistingMember(driveId, invitedUserId);

  // POL-2: adding a person who is not in the org to an org drive makes them a guest. Asked here, where the
  // membership is about to be created or upgraded. A row that is already an accepted membership is a role change
  // by an admin, not an admission. Off refuses; approve queues the request and grants nothing; on proceeds.
  if (!skipGuestPolicy && (!existingMember || existingMember.acceptedAt === null || isGuestRole(existingMember.role))) {
    const blocked = await guestPolicyResponse({
      driveId,
      userId: invitedUserId,
      hold: { origin: 'invite', request: { role, customRoleId: customRoleId ?? null, permissions, invitedBy: inviterUserId } },
      requestedBy: inviterUserId,
    });
    if (blocked) return blocked;
  }

  let memberId: string;
  let permissionsGranted = 0;
  // A GUEST row (redeemed page share link) is upgraded in place below, and for
  // the drive that is a join: it gets the same side effects as a new member.
  const isFreshJoin = !existingMember || isGuestRole(existingMember.role);

  if (!existingMember) {
    const result = await driveInviteRepository.createAcceptedMemberWithPermissions({
      driveId,
      userId: invitedUserId,
      role,
      customRoleId: customRoleId ?? null,
      invitedBy: inviterUserId,
      permissions,
      grantedBy: inviterUserId,
      validPageIds,
    });
    if ('refused' in result) return admissionRefusalResponse(result.refusal);
    memberId = result.memberId;
    permissionsGranted = result.permissionsGranted;
  } else {
    await driveInviteRepository.updateDriveMemberRole(
      existingMember.id,
      role,
      customRoleId ?? null
    );
    memberId = existingMember.id;
    for (const perm of permissions) {
      if (!validPageIds.has(perm.pageId)) {
        loggers.api.warn(`Invalid page ID ${perm.pageId} for drive ${driveId}`);
        continue;
      }
      const existing = await driveInviteRepository.findPagePermission(perm.pageId, invitedUserId);
      if (existing) {
        await driveInviteRepository.updatePagePermission(existing.id, {
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
          grantedBy: inviterUserId,
          grantedAt: new Date(),
        });
      } else {
        await driveInviteRepository.createPagePermission({
          pageId: perm.pageId,
          userId: invitedUserId,
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
          canDelete: false,
          grantedBy: inviterUserId,
        });
      }
      permissionsGranted += 1;
    }
  }

  if (isFreshJoin) {
    const ports = buildAcceptancePorts(request);
    const data: AcceptedInviteData = {
      memberId,
      driveId,
      driveName: drive.name,
      role,
      customRoleId: role === 'ADMIN' ? null : (customRoleId ?? null),
      invitedUserId,
      inviterUserId,
      ...(sourceEmail !== undefined && { inviteEmail: sourceEmail }),
    };
    await emitAcceptanceSideEffects(ports, data, permissionsGranted);
  } else {
    auditRequest(request, {
      eventType: 'authz.permission.granted',
      userId: inviterUserId,
      resourceType: 'drive',
      resourceId: driveId,
      details: {
        targetUserId: invitedUserId,
        role,
        operation: 'invite',
        ...(sourceEmail ? { sourceEmail } : {}),
      },
    });
  }

  return NextResponse.json({
    kind: 'added',
    memberId,
    permissionsGranted,
    message: `User added with ${permissionsGranted} page permissions`,
  });
}

export async function handleEmailPath(args: {
  request: Request;
  body: EmailBody;
  drive: DriveSummary;
  driveId: string;
  inviterUserId: string;
  // Set ONLY when an Owner or Admin approved this guest from the queue (POL-2).
  skipGuestPolicy?: boolean;
}): Promise<Response> {
  const { request, body, drive, driveId, inviterUserId, skipGuestPolicy } = args;
  // Email arrives already trimmed + lowercased by the Zod schema's pipe.
  const { email, role, customRoleId, permissions } = body;

  // Pair-scoped rate limit (drive + email): catches a single drive spamming one address.
  const driveRl = await checkDistributedRateLimit(
    `drive_invite:drive:${driveId}:${email}`,
    DISTRIBUTED_RATE_LIMITS.DRIVE_INVITE
  );
  if (!driveRl.allowed) {
    return NextResponse.json(
      { error: 'Too many invitations to this address. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(driveRl.retryAfter ?? 900) } }
    );
  }
  // Global per-email limit: catches the same address being spammed across drives.
  const emailRl = await checkDistributedRateLimit(
    `drive_invite:email:${email}`,
    DISTRIBUTED_RATE_LIMITS.DRIVE_INVITE
  );
  if (!emailRl.allowed) {
    return NextResponse.json(
      { error: 'Too many invitations to this address. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(emailRl.retryAfter ?? 900) } }
    );
  }

  const now = new Date();
  const pendingForEmail = await driveInviteRepository.findActivePendingInviteByDriveAndEmail(
    driveId,
    email,
    now,
  );
  if (pendingForEmail) {
    return NextResponse.json(
      { error: 'An invitation is already pending for this email.', existingMemberId: pendingForEmail.id },
      { status: 409 }
    );
  }

  const existingUser = await driveInviteRepository.findUserIdByEmail(email);

  // A suspended user must not be added — even if they're verified — bypassing
  // suspension via email lookup would let an admin re-grant access. Tested.
  if (existingUser?.suspendedAt) {
    return NextResponse.json(
      { error: 'This account is suspended and cannot be invited.' },
      { status: 403 }
    );
  }

  // Email maps to a verified user with no pending row → fall through to add path.
  if (existingUser && existingUser.emailVerified) {
    const alreadyAcceptedMember = await driveInviteRepository.findExistingMember(driveId, existingUser.id);
    // A guest is not a member yet: fall through so the add path upgrades it.
    if (alreadyAcceptedMember && alreadyAcceptedMember.acceptedAt && !isGuestRole(alreadyAcceptedMember.role)) {
      return NextResponse.json(
        { error: 'User is already a member of this drive.', existingMemberId: alreadyAcceptedMember.id },
        { status: 409 }
      );
    }
    return await handleUserIdPath({
      request,
      body: {
        userId: existingUser.id,
        role,
        customRoleId: customRoleId ?? null,
        permissions,
      },
      drive,
      driveId,
      inviterUserId,
      sourceEmail: email,
      skipVerificationCheck: true,
      skipGuestPolicy,
    });
  }

  // Page-level permissions for a not-yet-registered user have no target to
  // attach to. Reject explicitly rather than silently dropping them.
  if (permissions.length > 0) {
    return NextResponse.json(
      {
        error: 'Page-level permissions cannot be granted to a user who has not joined yet. Invite first, then grant permissions after they accept.',
      },
      { status: 422 }
    );
  }

  // POL-2: an address with no verified account is an outsider. The policy is applied BEFORE the invitation is stored
  // or sent, so a refused or queued guest never receives an email; acceptance asks again (the org may have changed
  // its policy since).
  if (!skipGuestPolicy) {
    const blocked = await guestPolicyResponse({
      driveId,
      email,
      hold: { origin: 'invite', request: { role, customRoleId: customRoleId ?? null, permissions, expiryDays: body.expiryDays ?? null, invitedBy: inviterUserId } },
      requestedBy: inviterUserId,
    });
    if (blocked) return blocked;
  }

  // Email maps to no user OR an unverified existing user (orphan from a prior
  // revoked invite). Both paths route through the consent-screen invitation
  // flow — no users row is created at invite-send time.
  const appUrl = resolveAppUrl();
  if (!appUrl) {
    loggers.api.error(
      'Drive invite email cannot be sent: WEB_APP_URL and NEXT_PUBLIC_APP_URL both unset'
    );
    return NextResponse.json(
      { error: 'Email delivery is not configured on this deployment.' },
      { status: 500 }
    );
  }

  if (customRoleId && role !== 'ADMIN') {
    const roleExists = await db
      .select({ id: driveRoles.id })
      .from(driveRoles)
      .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
      .limit(1);
    if (roleExists.length === 0) {
      return NextResponse.json({ error: 'Custom role not found in this drive' }, { status: 400 });
    }
  }

  const expiryDays = 'expiryDays' in body ? body.expiryDays : undefined;
  const { token, tokenHash, expiresAt } = createInviteToken({
    now,
    expiryMinutes: expiryDays ? expiryDays * 24 * 60 : null,
  });

  let pendingInvite: { id: string };
  try {
    pendingInvite = await driveInviteRepository.createPendingInvite({
      tokenHash,
      email,
      driveId,
      role,
      customRoleId: role === 'ADMIN' ? null : (customRoleId ?? null),
      invitedBy: inviterUserId,
      expiresAt,
      now,
    });
  } catch (insertError) {
    // The active-pending pre-check above filters out unexpired-unconsumed rows,
    // and createPendingInvite sweeps expired-unconsumed rows for the same
    // (driveId, email) pair inside its transaction. The only path to a unique
    // violation here is a concurrent re-invite race — surface as 409.
    const message = insertError instanceof Error ? insertError.message : String(insertError);
    const isUniqueViolation =
      message.includes('pending_invites_active_drive_email_idx') ||
      message.includes('pending_invites_token_hash_unique') ||
      message.includes('duplicate key');
    if (isUniqueViolation) {
      return NextResponse.json(
        { error: 'An invitation is already pending for this email.' },
        { status: 409 }
      );
    }
    loggers.api.error(
      'Failed to persist pending invite',
      insertError instanceof Error ? insertError : new Error(String(insertError)),
      { driveId }
    );
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }

  const inviter = await driveInviteRepository.findInviterDisplay(inviterUserId);
  // ps_invite_* tokens are URL-safe (cuid2 alnum); encodeURIComponent is
  // defensive belt-and-suspenders.
  const inviteUrl = `${appUrl}/invite/${encodeURIComponent(token)}`;

  // If the email send fails, we must roll back the pending_invites row — an
  // orphaned row without a sent invite would block legitimate re-invites
  // (the partial unique index covers consumedAt IS NULL regardless of
  // expiresAt).
  try {
    await sendPendingDriveInvitationEmail({
      recipientEmail: email,
      inviterName: inviter?.name ?? 'A teammate',
      driveName: drive.name,
      inviteUrl,
    });
  } catch (emailError) {
    loggers.api.error(
      'Failed to send pending drive invitation email; rolling back pending invite row',
      emailError instanceof Error ? emailError : new Error(String(emailError)),
      { driveId, recipientEmail: email }
    );
    try {
      await driveInviteRepository.deletePendingInvite(pendingInvite.id);
    } catch (rollbackError) {
      loggers.api.error(
        'Rollback of pending_invites row failed after email send failure',
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        { inviteId: pendingInvite.id, driveId }
      );
    }
    return NextResponse.json(
      { error: 'Failed to send invitation email. Please try again.' },
      { status: 502 }
    );
  }

  trackDriveOperation(inviterUserId, 'invite_member', driveId, {
    invitedEmail: email,
    role,
    pending: true,
  });

  // Pending invites have no targetUserId — the audit event captures this
  // event keyed on email below. logMemberActivity is intentionally skipped
  // on this path (its targetUserId param would have to be a synthetic
  // placeholder, which historically caused PII-aliasing bugs).

  auditRequest(request, {
    eventType: 'authz.permission.granted',
    userId: inviterUserId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { targetEmail: email, role, operation: 'invite', pending: true },
  });

  return NextResponse.json({
    kind: 'invited',
    memberId: pendingInvite.id,
    email,
    message: `Invitation sent to ${email}`,
  });
}

