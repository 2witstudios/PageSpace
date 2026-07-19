import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { withAdminAuth } from '@/lib/auth';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { notifyUserSessionsRevoked } from '@pagespace/lib/auth/session-revocation-notify';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

type RouteContext = { params: Promise<{ userId: string }> };

const suspendSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to suspend a user').max(500),
});

const unsuspendSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * POST /api/admin/users/[userId]/suspend
 * Suspend a user: sets suspendedAt/suspendedReason (enforced at login and
 * session validation) and revokes all of the user's sessions immediately.
 * Requires a non-empty reason.
 */
export const POST = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    if (targetUserId === adminUser.id) {
      return NextResponse.json(
        { error: 'You cannot suspend your own account' },
        { status: 400 }
      );
    }

    const parsed = suspendSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty reason is required to suspend a user', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { reason } = parsed.data;

    const [target] = await db
      .select({ id: users.id, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (target.suspendedAt) {
      return NextResponse.json({ error: 'User is already suspended' }, { status: 409 });
    }

    await db
      .update(users)
      .set({ suspendedAt: new Date(), suspendedReason: reason })
      .where(eq(users.id, targetUserId));

    // Kill every live session so the suspension takes effect immediately.
    const revokedSessions = await sessionService.revokeAllUserSessions(targetUserId, 'admin_suspension');

    // A revoked DB session must not leave an already-open socket connected —
    // notify realtime so it disconnects the target's live sockets right now.
    if (revokedSessions > 0) {
      await notifyUserSessionsRevoked(targetUserId, 'admin_suspension');
    }

    // Free-text reason stays in the audit event only — not in general API logs.
    loggers.api.info('Admin suspended user', {
      adminId: adminUser.id,
      targetUserId,
      revokedSessions,
    });

    auditRequest(request, {
      eventType: 'admin.user.suspended',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'suspend',
        reason,
        revokedSessions,
      },
    });

    return NextResponse.json({
      success: true,
      revokedSessions,
      message: 'User suspended and all sessions revoked',
    });
  } catch (error) {
    loggers.api.error('Error suspending user', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to suspend user' }, { status: 500 });
  }
});

/**
 * DELETE /api/admin/users/[userId]/suspend
 * Lift a suspension: clears suspendedAt/suspendedReason. Optional reason.
 */
export const DELETE = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    const parsed = unsuspendSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const reason = parsed.data.reason || 'Admin unsuspend';

    const [target] = await db
      .select({ id: users.id, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (!target.suspendedAt) {
      return NextResponse.json({ error: 'User is not suspended' }, { status: 409 });
    }

    await db
      .update(users)
      .set({ suspendedAt: null, suspendedReason: null })
      .where(eq(users.id, targetUserId));

    loggers.api.info('Admin unsuspended user', {
      adminId: adminUser.id,
      targetUserId,
    });

    auditRequest(request, {
      eventType: 'admin.user.reactivated',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'unsuspend',
        reason,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Suspension lifted. The user can sign in again.',
    });
  } catch (error) {
    loggers.api.error('Error unsuspending user', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to unsuspend user' }, { status: 500 });
  }
});
