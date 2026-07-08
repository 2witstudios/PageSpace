import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { withAdminAuth } from '@/lib/auth';
import { updateUserRole } from '@/lib/auth/admin-role';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

type RouteContext = { params: Promise<{ userId: string }> };

const roleSchema = z.object({
  role: z.enum(['user', 'admin']),
  reason: z.string().trim().min(1, 'A reason is required to change a role').max(500),
});

/**
 * PATCH /api/admin/users/[userId]/role
 * Promote/demote a user. Bumps adminRoleVersion via updateUserRole so any
 * cached admin sessions for the target are invalidated immediately.
 * Admins cannot change their own role (no self-demotion / lockout).
 */
export const PATCH = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;

    if (targetUserId === adminUser.id) {
      return NextResponse.json(
        { error: 'You cannot change your own role' },
        { status: 400 }
      );
    }

    const parsed = roleSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request. Role must be "user" or "admin" and a non-empty reason is required.', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { role, reason } = parsed.data;

    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (target.role === role) {
      return NextResponse.json({ error: `User already has the ${role} role` }, { status: 409 });
    }

    const updated = await updateUserRole(targetUserId, role);
    if (!updated) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    loggers.api.info('Admin changed user role', {
      adminId: adminUser.id,
      targetUserId,
      previousRole: target.role,
      newRole: updated.role,
      reason,
    });

    auditRequest(request, {
      eventType: role === 'admin' ? 'authz.role.assigned' : 'authz.role.removed',
      userId: adminUser.id,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'change_role',
        previousRole: target.role,
        newRole: updated.role,
        reason,
      },
    });

    return NextResponse.json({
      success: true,
      role: updated.role,
      message: role === 'admin' ? 'User promoted to admin' : 'Admin access removed',
    });
  } catch (error) {
    loggers.api.error('Error changing user role', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to change role' }, { status: 500 });
  }
});
