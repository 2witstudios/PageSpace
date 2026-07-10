import { NextResponse } from 'next/server';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { mcpTokenDrives, driveRoles } from '@pagespace/db/schema/members';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

/**
 * GET /api/drives/{driveId}/apps/members
 * List all MCP token drive members with their role and token name.
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
      return NextResponse.json({ error: 'You must be a drive member to view app members' }, { status: 403 });
    }

    const rows = await db
      .select({
        id: mcpTokenDrives.id,
        tokenId: mcpTokenDrives.tokenId,
        role: mcpTokenDrives.role,
        createdAt: mcpTokenDrives.createdAt,
        customRoleId: mcpTokenDrives.customRoleId,
        name: mcpTokens.name,
        customRoleName: driveRoles.name,
        customRoleColor: driveRoles.color,
      })
      .from(mcpTokenDrives)
      .leftJoin(mcpTokens, eq(mcpTokenDrives.tokenId, mcpTokens.id))
      .leftJoin(driveRoles, eq(mcpTokenDrives.customRoleId, driveRoles.id))
      .where(and(eq(mcpTokenDrives.driveId, driveId), isNull(mcpTokens.revokedAt)));

    const appMembers = rows.map((row) => ({
      id: row.id,
      tokenId: row.tokenId,
      name: row.name,
      role: row.role,
      createdAt: row.createdAt,
      customRole: row.customRoleId
        ? { id: row.customRoleId, name: row.customRoleName ?? row.customRoleId, color: row.customRoleColor ?? null }
        : null,
    }));

    return NextResponse.json({
      appMembers,
      currentUserRole: access.isOwner ? 'OWNER' : access.isAdmin ? 'ADMIN' : 'MEMBER',
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch app members' }, { status: 500 });
  }
}
