import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { mcpTokenDrives, driveRoles } from '@pagespace/db/schema/members';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { guardDriveAccess, isOrgLapsedError } from '@pagespace/lib/permissions/org-lapse-guard';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const patchBodySchema = z.object({
  // null = clear back to INHERIT (the key acts as its owner in this drive)
  role: z.enum(['MEMBER', 'ADMIN']).nullable().optional(),
  customRoleId: z.string().min(1).nullable().optional(),
});

/**
 * PATCH /api/drives/{driveId}/apps/{tokenId}
 * Update role or customRoleId for an MCP token drive member.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; tokenId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, tokenId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can update app members' }, { status: 403 });
    }

    const rawBody = await request.json();
    const parsed = patchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { role, customRoleId } = parsed.data;

    if (role === undefined && customRoleId === undefined) {
      return NextResponse.json({ error: 'Provide at least one of: role, customRoleId' }, { status: 400 });
    }

    const existing = await db
      .select({ id: mcpTokenDrives.id, ownerUserId: mcpTokens.userId })
      .from(mcpTokenDrives)
      .innerJoin(mcpTokens, eq(mcpTokenDrives.tokenId, mcpTokens.id))
      .where(and(eq(mcpTokenDrives.driveId, driveId), eq(mcpTokenDrives.tokenId, tokenId)))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json({ error: 'App member not found' }, { status: 404 });
    }

    // Clearing back to inherit requires the token's OWNER to be a drive member —
    // otherwise the row would resolve to nothing (confusing dead state).
    if (role === null) {
      const ownerIsMember = await isUserDriveMember(existing[0].ownerUserId, driveId);
      if (!ownerIsMember) {
        return NextResponse.json(
          { error: "Cannot set this app to inherit: its owner is not a member of this drive. Assign an explicit role instead." },
          { status: 400 },
        );
      }
    }

    if (customRoleId) {
      const roleExists = await db
        .select({ id: driveRoles.id })
        .from(driveRoles)
        .where(and(eq(driveRoles.id, customRoleId), eq(driveRoles.driveId, driveId)))
        .limit(1);
      if (roleExists.length === 0) {
        return NextResponse.json({ error: 'Custom role not found in this drive' }, { status: 404 });
      }
    }

    const updateValues: Partial<typeof mcpTokenDrives.$inferInsert> = {};
    if (role !== undefined) updateValues.role = role;
    if (customRoleId !== undefined) updateValues.customRoleId = customRoleId;

    // [D-OW-33] an explicit role is NOT bounded by the token owner's access: raising a key to ADMIN (from MEMBER or
    // inherit), or to a wider custom role, loosens the drive. guardDriveAccess undoes it while the drive's org is
    // lapsed (402); narrowing a key still applies.
    let updated: typeof mcpTokenDrives.$inferSelect | undefined;
    try {
      [updated] = await guardDriveAccess(db, driveId, { members: false, grants: false, agents: false }, (tx) =>
        tx
          .update(mcpTokenDrives)
          .set(updateValues)
          .where(and(eq(mcpTokenDrives.driveId, driveId), eq(mcpTokenDrives.tokenId, tokenId)))
          .returning(),
      );
    } catch (error) {
      if (isOrgLapsedError(error)) return orgLapsedResponse();
      throw error;
    }

    auditRequest(request, {
      eventType: 'authz.role.assigned',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { tokenId, role, customRoleId },
    });

    return NextResponse.json({ success: true, member: updated });
  } catch (error) {
    loggers.api.error('Error updating drive app member:', error as Error);
    return NextResponse.json({ error: 'Failed to update app member' }, { status: 500 });
  }
}

/**
 * DELETE /api/drives/{driveId}/apps/{tokenId}
 * Remove an MCP token from drive membership.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; tokenId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, tokenId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can remove app members' }, { status: 403 });
    }

    const existing = await db
      .select({ id: mcpTokenDrives.id })
      .from(mcpTokenDrives)
      .where(and(eq(mcpTokenDrives.driveId, driveId), eq(mcpTokenDrives.tokenId, tokenId)))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json({ error: 'App member not found' }, { status: 404 });
    }

    await db
      .delete(mcpTokenDrives)
      .where(and(eq(mcpTokenDrives.driveId, driveId), eq(mcpTokenDrives.tokenId, tokenId)));

    auditRequest(request, {
      eventType: 'authz.permission.revoked',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { tokenId },
    });

    return NextResponse.json({ success: true, message: 'App member removed successfully' });
  } catch (error) {
    loggers.api.error('Error removing drive app member:', error as Error);
    return NextResponse.json({ error: 'Failed to remove app member' }, { status: 500 });
  }
}
