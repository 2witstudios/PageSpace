import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingConnectionInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';
import { createNotification } from '@pagespace/lib/notifications/notifications';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const inviteBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
  message: z.string().max(500).optional(),
});

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const inviterUserId = auth.userId;

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
    const { email, message } = parsed.data;

    // Fetch inviter info once — used for self-invite check + display name later.
    const inviterDisplay = await connectionInviteRepository.findInviterDisplay(inviterUserId);

    // Self-invite check (R5)
    if (inviterDisplay?.email === email) {
      return NextResponse.json(
        { error: 'Cannot connect with yourself' },
        { status: 400 }
      );
    }

    // Pair-scoped rate limit: catches a single user spamming one address.
    const pairRl = await checkDistributedRateLimit(
      `connection_invite:inviter:${inviterUserId}:${email}`,
      DISTRIBUTED_RATE_LIMITS.CONNECTION_INVITE
    );
    if (!pairRl.allowed) {
      return NextResponse.json(
        { error: 'Too many invitations to this address. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(pairRl.retryAfter ?? 900) } }
      );
    }
    // Global per-email limit: catches the same address being spammed across inviters.
    const emailRl = await checkDistributedRateLimit(
      `connection_invite:email:${email}`,
      DISTRIBUTED_RATE_LIMITS.CONNECTION_INVITE
    );
    if (!emailRl.allowed) {
      return NextResponse.json(
        { error: 'Too many invitations to this address. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(emailRl.retryAfter ?? 900) } }
      );
    }

    const targetUser = await connectionInviteRepository.findUserIdByEmail(email);

    // Suspended-account gate (mirror drive route line 348).
    if (targetUser?.suspendedAt) {
      return NextResponse.json(
        { error: 'This account is suspended and cannot be invited.' },
        { status: 403 }
      );
    }

    // Existing verified user → fast path (R1): create PENDING connection directly.
    if (targetUser && targetUser.emailVerified) {
      const existingConn = await connectionInviteRepository.findExistingConnection(
        inviterUserId,
        targetUser.id
      );
      if (existingConn) {
        if (existingConn.status === 'ACCEPTED') {
          return NextResponse.json(
            { error: 'Already connected with this user' },
            { status: 400 }
          );
        }
        if (existingConn.status === 'PENDING') {
          return NextResponse.json(
            { error: 'Connection request already pending' },
            { status: 400 }
          );
        }
        if (existingConn.status === 'BLOCKED') {
          return NextResponse.json(
            { error: 'Cannot send connection request' },
            { status: 400 }
          );
        }
      }

      let newConn: { id: string };
      try {
        newConn = await connectionInviteRepository.createDirectConnection({
          inviterUserId,
          targetUserId: targetUser.id,
          requestMessage: message,
        });
      } catch (insertError) {
        // Two concurrent requests can both pass the existence check and race
        // on the connections_user_pair_key unique constraint. Map this to a
        // deterministic conflict response rather than a 500.
        const msg = insertError instanceof Error ? insertError.message : String(insertError);
        const isUniqueViolation =
          msg.includes('connections_user_pair_key') ||
          (msg.includes('duplicate key') && msg.includes('connections'));
        if (isUniqueViolation) {
          return NextResponse.json(
            { error: 'Connection request already pending' },
            { status: 400 }
          );
        }
        throw insertError;
      }

      const senderName = inviterDisplay?.name ?? 'Someone';
      await createNotification({
        userId: targetUser.id,
        type: 'CONNECTION_REQUEST',
        title: 'New Connection Request',
        message: `${senderName} wants to connect with you`,
        metadata: {
          connectionId: newConn.id,
          senderId: inviterUserId,
          requestMessage: message,
          requesterName: senderName,
        },
        triggeredByUserId: inviterUserId,
      });

      auditRequest(request, {
        eventType: 'data.write',
        userId: inviterUserId,
        resourceType: 'connection',
        resourceId: newConn.id,
        details: { targetUserId: targetUser.id, via: 'email-invite', email },
      });

      return NextResponse.json({
        kind: 'requested',
        connectionId: newConn.id,
        message: `Connection request sent to ${email}`,
      });
    }

    // New-user path (R2): create pending invite row + send email.
    const now = new Date();

    const existingPending = await connectionInviteRepository.findActivePendingInviteByOwnerAndEmail(
      inviterUserId,
      email,
      now
    );
    if (existingPending) {
      return NextResponse.json(
        { error: 'An invitation is already pending for this email.' },
        { status: 409 }
      );
    }

    const appUrl = resolveAppUrl();
    if (!appUrl) {
      loggers.api.error(
        'Connection invite email cannot be sent: WEB_APP_URL and NEXT_PUBLIC_APP_URL both unset'
      );
      return NextResponse.json(
        { error: 'Email delivery is not configured on this deployment.' },
        { status: 500 }
      );
    }

    const { token, tokenHash, expiresAt } = createInviteToken({ now });

    let pendingInvite: { id: string };
    try {
      pendingInvite = await connectionInviteRepository.createPendingInvite({
        tokenHash,
        email,
        invitedBy: inviterUserId,
        requestMessage: message ?? null,
        expiresAt,
        now,
      });
    } catch (insertError) {
      const msg = insertError instanceof Error ? insertError.message : String(insertError);
      const isUniqueViolation =
        msg.includes('pending_connection_invites_active_inviter_email_idx') ||
        msg.includes('pending_connection_invites_token_hash_unique') ||
        msg.includes('duplicate key');
      if (isUniqueViolation) {
        return NextResponse.json(
          { error: 'An invitation is already pending for this email.' },
          { status: 409 }
        );
      }
      loggers.api.error(
        'Failed to persist pending connection invite',
        insertError instanceof Error ? insertError : new Error(String(insertError))
      );
      return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
    }

    // ps_invite_* tokens are URL-safe (cuid2 alnum); encodeURIComponent is defensive.
    const inviteUrl = `${appUrl}/invite/${encodeURIComponent(token)}`;

    // If email fails, compensating-delete the pending row (R6).
    try {
      await sendPendingConnectionInvitationEmail({
        recipientEmail: email,
        inviterName: inviterDisplay?.name ?? 'A teammate',
        message,
        inviteUrl,
      });
    } catch (emailError) {
      loggers.api.error(
        'Failed to send pending connection invitation email; rolling back pending invite row',
        emailError instanceof Error ? emailError : new Error(String(emailError)),
        { recipientEmail: email }
      );
      try {
        await connectionInviteRepository.deletePendingInvite(pendingInvite.id);
      } catch (rollbackError) {
        loggers.api.error(
          'Rollback of pending_connection_invites row failed after email send failure',
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
          { inviteId: pendingInvite.id }
        );
      }
      return NextResponse.json(
        { error: 'Failed to send invitation email. Please try again.' },
        { status: 502 }
      );
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: inviterUserId,
      resourceType: 'connection',
      resourceId: pendingInvite.id,
      details: { targetEmail: email, operation: 'invite', pending: true },
    });

    return NextResponse.json({
      kind: 'invited',
      inviteId: pendingInvite.id,
      email,
      message: `Connection invite sent to ${email}`,
    });
  } catch (error) {
    loggers.api.error('Error creating connection invite:', error as Error);
    return NextResponse.json({ error: 'Failed to create connection invite' }, { status: 500 });
  }
}
