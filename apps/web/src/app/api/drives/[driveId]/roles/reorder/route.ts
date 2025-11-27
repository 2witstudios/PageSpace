import { NextResponse } from 'next/server';
import { db, eq, and } from '@pagespace/db';
import { driveRoles, driveMembers } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// PATCH /api/drives/[driveId]/roles/reorder - Reorder roles
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user is owner or admin
    const membership = await db.query.driveMembers.findFirst({
      where: and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId)
      ),
    });

    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return NextResponse.json({ error: 'Only owners and admins can reorder roles' }, { status: 403 });
    }

    const body = await request.json();
    const { roleIds } = body;

    if (!Array.isArray(roleIds)) {
      return NextResponse.json({ error: 'roleIds must be an array' }, { status: 400 });
    }

    // Validate that all roleIds belong to this drive
    const existingRoles = await db.query.driveRoles.findMany({
      where: eq(driveRoles.driveId, driveId),
      columns: { id: true },
    });
    const existingIds = new Set(existingRoles.map(r => r.id));
    const invalidIds = roleIds.filter((id: string) => !existingIds.has(id));

    if (invalidIds.length > 0) {
      return NextResponse.json({ error: 'Invalid role IDs' }, { status: 400 });
    }

    // Update positions for each role in a transaction to prevent race conditions
    await db.transaction(async (tx) => {
      for (let index = 0; index < roleIds.length; index++) {
        const roleId = roleIds[index];
        await tx.update(driveRoles)
          .set({ position: index, updatedAt: new Date() })
          .where(and(
            eq(driveRoles.id, roleId),
            eq(driveRoles.driveId, driveId)
          ));
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error reordering roles:', error);
    return NextResponse.json({ error: 'Failed to reorder roles' }, { status: 500 });
  }
}
