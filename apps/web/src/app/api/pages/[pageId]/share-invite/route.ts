import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingPageShareInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { canUserSharePage } from '@pagespace/lib/permissions/permissions';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const shareInviteBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
    permissions: z
      .array(z.enum(['VIEW', 'EDIT', 'SHARE']))
      .min(1, 'At least VIEW permission is required'),
    expiryDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .superRefine(({ permissions }, ctx) => {
    if (
      (permissions.includes('EDIT') || permissions.includes('SHARE')) &&
      !permissions.includes('VIEW')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: 'VIEW is required when EDIT or SHARE is granted',
      });
    }
  });

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const inviterUserId = auth.userId;

    const { pageId } = await context.params;

    // R3: canShare check BEFORE any row is written
    const hasSharePermission = await canUserSharePage(inviterUserId, pageId);
    if (!hasSharePermission) {
      return NextResponse.json(
        { error: 'You do not have permission to share this page.' },
        { status: 403 },
      );
    }

    const emailVerified = await isEmailVerified(inviterUserId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = shareInviteBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { email, permissions } = parsed.data;

    // R5: DELETE is blocked at the zod layer above; this is a belt-and-suspenders guard
    // (the zod enum only allows VIEW | EDIT | SHARE, so DELETE can never reach here)

    const page = await pageInviteRepository.findPageById(pageId);
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Pair-scoped rate limit (inviter + email)
    const inviterRl = await checkDistributedRateLimit(
      `page_share_invite:inviter:${inviterUserId}:${email}`,
      DISTRIBUTED_RATE_LIMITS.PAGE_SHARE_INVITE,
    );
    if (!inviterRl.allowed) {
      return NextResponse.json(
        { error: 'Too many invitations to this address. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(inviterRl.retryAfter ?? 900) } },
      );
    }

    // Global per-email rate limit
    const emailRl = await checkDistributedRateLimit(
      `page_share_invite:email:${email}`,
      DISTRIBUTED_RATE_LIMITS.PAGE_SHARE_INVITE,
    );
    if (!emailRl.allowed) {
      return NextResponse.json(
        { error: 'Too many invitations to this address. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(emailRl.retryAfter ?? 900) } },
      );
    }

    const existingUser = await pageInviteRepository.findUserIdByEmail(email);

    // Suspended users cannot be invited regardless of verification status
    if (existingUser?.suspendedAt) {
      return NextResponse.json(
        { error: 'This account is suspended and cannot be invited.' },
        { status: 403 },
      );
    }

    // R1: Existing verified user — direct grant, no pendingPageInvites row
    if (existingUser && existingUser.emailVerified) {
      const permissionRow = await pageInviteRepository.createDirectPagePermission({
        pageId,
        userId: existingUser.id,
        canView: permissions.includes('VIEW'),
        canEdit: permissions.includes('EDIT'),
        canShare: permissions.includes('SHARE'),
        grantedBy: inviterUserId,
      });

      auditRequest(request, {
        eventType: 'authz.permission.granted',
        userId: inviterUserId,
        resourceType: 'page',
        resourceId: pageId,
        details: { targetUserId: existingUser.id, permissions, operation: 'share_invite_direct' },
      });

      return NextResponse.json({
        kind: 'granted',
        permissionId: permissionRow.id,
        message: `Permissions granted to ${email}`,
      });
    }

    // R2: Non-existing user (or unverified existing user) — create pending invite

    const now = new Date();

    const activePending = await pageInviteRepository.findActivePendingInviteByPageAndEmail(
      pageId,
      email,
      now,
    );
    if (activePending) {
      return NextResponse.json(
        { error: 'An invitation is already pending for this email.', existingInviteId: activePending.id },
        { status: 409 },
      );
    }

    const appUrl = resolveAppUrl();
    if (!appUrl) {
      loggers.api.error(
        'Page share invite email cannot be sent: WEB_APP_URL and NEXT_PUBLIC_APP_URL both unset',
      );
      return NextResponse.json(
        { error: 'Email delivery is not configured on this deployment.' },
        { status: 500 },
      );
    }

    const { token, tokenHash, expiresAt } = createInviteToken({
      now,
      expiryMinutes: body.expiryDays ? body.expiryDays * 24 * 60 : null,
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
        return NextResponse.json(
          { error: 'An invitation is already pending for this email.' },
          { status: 409 },
        );
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
      return NextResponse.json(
        { error: 'Failed to send invitation email. Please try again.' },
        { status: 502 },
      );
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
  } catch (error) {
    loggers.api.error('Error in page share invite:', error as Error);
    return NextResponse.json({ error: 'Failed to send invite' }, { status: 500 });
  }
}
