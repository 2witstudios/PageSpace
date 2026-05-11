import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { emitAcceptanceSideEffects, type AcceptedInviteData } from '@pagespace/lib/services/invites';
import { buildAcceptancePorts } from '@/lib/auth/invite-acceptance-adapters';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const permissionEntrySchema = z.object({
  pageId: z.string().min(1),
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
});

// Discriminated by which identity field is present. Role enum is enforced
// here at the boundary — PR #1229 took the role through a TypeScript cast
// and accepted 'OWNER' silently. Zod refuses it now.
const inviteBodySchema = z.union([
  z.object({
    userId: z.string().min(1),
    role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
    customRoleId: z.string().nullable().optional(),
    permissions: z.array(permissionEntrySchema).default([]),
  }),
  z.object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
    role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
    customRoleId: z.string().nullable().optional(),
    permissions: z.array(permissionEntrySchema).default([]),
    expiryDays: z.number().int().min(1).max(365).nullable().optional(),
  }),
]);

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const inviterUserId = auth.userId;

    const { driveId } = await context.params;

    const emailVerified = await isEmailVerified(inviterUserId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 }
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = inviteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const body = parsed.data;

    const drive = await driveInviteRepository.findDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive.ownerId === inviterUserId;
    let isAcceptedAdmin = false;
    if (!isOwner) {
      // findAdminMembership filters acceptedAt IS NOT NULL — Epic 1's gate.
      // A pending admin (not yet accepted) cannot exercise admin powers.
      const adminMembership = await driveInviteRepository.findAdminMembership(driveId, inviterUserId);
      isAcceptedAdmin = adminMembership !== null;
    }
    if (!isOwner && !isAcceptedAdmin) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can add members' },
        { status: 403 }
      );
    }

    if ('userId' in body) {
      return await handleUserIdPath({
        request,
        body,
        drive,
        driveId,
        inviterUserId,
      });
    }

    return await handleEmailPath({
      request,
      body,
      drive,
      driveId,
      inviterUserId,
    });
  } catch (error) {
    loggers.api.error('Error adding member:', error as Error);
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 });
  }
}

interface DriveSummary {
  id: string;
  name: string;
  ownerId: string;
}

interface UserIdBody {
  userId: string;
  role: 'MEMBER' | 'ADMIN';
  customRoleId?: string | null;
  permissions: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }>;
}

interface EmailBody {
  email: string;
  role: 'MEMBER' | 'ADMIN';
  customRoleId?: string | null;
  permissions: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }>;
}

async function handleUserIdPath(args: {
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
}): Promise<Response> {
  const { request, body, drive, driveId, inviterUserId, sourceEmail, skipVerificationCheck } = args;
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
      });
    }
  }

  const validPageIds = new Set(await driveInviteRepository.getValidPageIds(driveId));
  const existingMember = await driveInviteRepository.findExistingMember(driveId, invitedUserId);

  let memberId: string;
  let permissionsGranted = 0;
  const isFreshJoin = !existingMember;

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

async function handleEmailPath(args: {
  request: Request;
  body: EmailBody;
  drive: DriveSummary;
  driveId: string;
  inviterUserId: string;
}): Promise<Response> {
  const { request, body, drive, driveId, inviterUserId } = args;
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
    if (alreadyAcceptedMember && alreadyAcceptedMember.acceptedAt) {
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

