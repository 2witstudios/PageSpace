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

const revokeSessionsSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * DELETE /api/admin/users/[userId]/sessions
 * Force logout: revoke every live session (web, admin, device) for a user.
 * The user's account stays active — they can sign back in.
 */
export const DELETE = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    if (targetUserId === adminUser.id) {
      return NextResponse.json(
        { error: 'Use logout to end your own sessions' },
        { status: 400 }
      );
    }

    const parsed = revokeSessionsSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const reason = parsed.data.reason || 'Admin force logout';

    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const revokedSessions = await sessionService.revokeAllUserSessions(targetUserId, 'admin_force_logout');

    // A revoked DB session must not leave an already-open socket connected —
    // notify realtime so it disconnects the target's live sockets right now.
    if (revokedSessions > 0) {
      await notifyUserSessionsRevoked(targetUserId, 'admin_force_logout');
    }

    // Free-text reason stays in the audit event only — not in general API logs.
    loggers.api.info('Admin revoked all user sessions', {
      adminId: adminUser.id,
      targetUserId,
      revokedSessions,
    });

    auditRequest(request, {
      eventType: 'auth.session.revoked',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'force_logout',
        reason,
        revokedSessions,
      },
    });

    return NextResponse.json({
      success: true,
      revokedSessions,
      message: revokedSessions === 0
        ? 'User had no active sessions'
        : `Revoked ${revokedSessions} active session${revokedSessions === 1 ? '' : 's'}`,
    });
  } catch (error) {
    loggers.api.error('Error revoking user sessions', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
  }
});
