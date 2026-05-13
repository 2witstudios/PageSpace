import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { driveAgentMembers, driveRoles } from '@pagespace/db/schema/members';
import { pages } from '@pagespace/db/schema/core';

/**
 * GET /api/drives/{driveId}/agents/members
 * List all agent drive members with their role and page title.
 * Static segment "members" takes Next.js priority over [agentPageId].
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: false });
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isMember) {
      return NextResponse.json({ error: 'You must be a drive member to view agent members' }, { status: 403 });
    }

    const rows = await db
      .select({
        id: driveAgentMembers.id,
        agentPageId: driveAgentMembers.agentPageId,
        role: driveAgentMembers.role,
        addedAt: driveAgentMembers.addedAt,
        customRoleId: driveAgentMembers.customRoleId,
        title: pages.title,
        customRoleName: driveRoles.name,
        customRoleColor: driveRoles.color,
      })
      .from(driveAgentMembers)
      .leftJoin(pages, eq(driveAgentMembers.agentPageId, pages.id))
      .leftJoin(driveRoles, eq(driveAgentMembers.customRoleId, driveRoles.id))
      .where(eq(driveAgentMembers.driveId, driveId));

    const agentMembers = rows.map((row) => ({
      id: row.id,
      agentPageId: row.agentPageId,
      role: row.role,
      addedAt: row.addedAt,
      title: row.title,
      customRole: row.customRoleId
        ? { id: row.customRoleId, name: row.customRoleName ?? row.customRoleId, color: row.customRoleColor ?? null }
        : null,
    }));

    return NextResponse.json({
      agentMembers,
      currentUserRole: access.isOwner ? 'OWNER' : access.isAdmin ? 'ADMIN' : 'MEMBER',
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch agent members' }, { status: 500 });
  }
}
