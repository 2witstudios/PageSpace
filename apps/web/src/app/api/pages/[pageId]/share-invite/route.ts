import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { pageShareGuestPolicyResponse, sendPendingPageInvite } from '@/lib/page-invites/share-invite-handlers';
import { guestsOffRefusal } from '@pagespace/lib/organizations/sharing-decisions';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { canUserSharePage } from '@pagespace/lib/permissions/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getDriveById } from '@pagespace/lib/services/drive-service';
import { isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { isOrgLapsedError } from '@pagespace/lib/permissions/org-lapse-guard';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';

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
    const { email, permissions, expiryDays } = parsed.data;

    // R5: DELETE is blocked at the zod layer above; this is a belt-and-suspenders guard
    // (the zod enum only allows VIEW | EDIT | SHARE, so DELETE can never reach here)

    const page = await pageInviteRepository.findPageById(pageId);
    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Home drive guard: pages inside a Home drive cannot be shared.
    const pageDrive = await getDriveById(page.driveId);
    if (pageDrive && isHomeDrive(pageDrive)) {
      return NextResponse.json({ error: homeDriveActionError(pageDrive, 'share') }, { status: 403 });
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

    const verifiedUserId = existingUser && existingUser.emailVerified ? existingUser.id : null;

    // POL-2: sharing a page of an org drive with someone outside the org admits a guest, so the org's guests policy
    // decides it before any row is written or any email sent. A verified account that already holds a grant on this
    // page gains nothing here (the direct grant never widens an existing one), so it is not asked.
    const alreadyGranted = verifiedUserId !== null && (await pageInviteRepository.findExistingPagePermission(pageId, verifiedUserId)) !== null;
    if (!alreadyGranted) {
      const held = await pageShareGuestPolicyResponse({ page, email, verifiedUserId, permissions, expiryDays: expiryDays ?? null, inviterUserId });
      if (held) return held;
    }

    // R1: Existing verified user — direct grant, no pendingPageInvites row
    if (existingUser && existingUser.emailVerified) {
      const permissionRow = await pageInviteRepository.createDirectPagePermission({
        pageId,
        driveId: page.driveId,
        userId: existingUser.id,
        canView: permissions.includes('VIEW'),
        canEdit: permissions.includes('EDIT'),
        canShare: permissions.includes('SHARE'),
        grantedBy: inviterUserId,
      });
      if (!permissionRow) {
        const refusal = guestsOffRefusal();
        return NextResponse.json({ error: refusal.message, code: refusal.code, policy: refusal.policy }, { status: refusal.status });
      }

      auditRequest(request, {
        eventType: 'authz.permission.granted',
        userId: inviterUserId,
        resourceType: 'page',
        resourceId: pageId,
        details: { targetUserId: existingUser.id, permissions, operation: 'share_invite_direct' },
      });

      if (page.driveId) {
        broadcastPageEvent(
          createPageEventPayload(page.driveId, pageId, 'updated')
        ).catch((err: Error) => {
          loggers.api.error('Failed to broadcast share-invite page event:', err);
        });
      }

      return NextResponse.json({
        kind: 'granted',
        permissionId: permissionRow.id,
        message: `Permissions granted to ${email}`,
      });
    }

    // R2: Non-existing user (or unverified existing user) — create pending invite
    return await sendPendingPageInvite({ request, page, email, permissions, expiryDays: expiryDays ?? null, inviterUserId });
  } catch (error) {
    // [D-OW-33] the drive's org is lapsed: a new grant or invitation would loosen access.
    if (isOrgLapsedError(error)) return orgLapsedResponse();
    loggers.api.error('Error in page share invite:', error as Error);
    return NextResponse.json({ error: 'Failed to send invite' }, { status: 500 });
  }
}
