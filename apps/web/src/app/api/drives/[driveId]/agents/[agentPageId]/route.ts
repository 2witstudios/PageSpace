import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { driveAgentMembers, driveRoles } from '@pagespace/db/schema/members';
import { guardDriveAccess, isOrgLapsedError } from '@pagespace/lib/permissions/org-lapse-guard';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const patchBodySchema = z.object({
  role: z.enum(['MEMBER', 'ADMIN']).optional(),
  customRoleId: z.string().min(1).nullable().optional(),
  includeContext: z.boolean().optional(),
});

/**
 * PATCH /api/drives/{driveId}/agents/{agentPageId}
 * Update role or customRoleId for an agent member
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; agentPageId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, agentPageId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can update agent members' }, { status: 403 });
    }

    const rawBody = await request.json();
    const parsed = patchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { role, customRoleId, includeContext } = parsed.data;

    if (!role && customRoleId === undefined && includeContext === undefined) {
      return NextResponse.json({ error: 'Provide at least one of: role, customRoleId, includeContext' }, { status: 400 });
    }

    // Verify membership exists
    const existing = await db
      .select({ id: driveAgentMembers.id })
      .from(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, driveId), eq(driveAgentMembers.agentPageId, agentPageId)))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json({ error: 'Agent member not found' }, { status: 404 });
    }

    // Validate customRoleId if provided
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

    const updateValues: Partial<typeof driveAgentMembers.$inferInsert> = {};
    if (role !== undefined) updateValues.role = role;
    if (customRoleId !== undefined) updateValues.customRoleId = customRoleId;
    if (includeContext !== undefined) updateValues.includeContext = includeContext;

    // [D-OW-33] a higher role, a wider custom role or the drive's context newly included loosens what the agent's
    // users read: guardDriveAccess undoes it and answers 402 while the drive's org is lapsed. Narrowing still applies.
    let updated: typeof driveAgentMembers.$inferSelect | undefined;
    try {
      [updated] = await guardDriveAccess(db, driveId, { members: false, grants: false }, (tx) =>
        tx
          .update(driveAgentMembers)
          .set(updateValues)
          .where(and(eq(driveAgentMembers.driveId, driveId), eq(driveAgentMembers.agentPageId, agentPageId)))
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
      details: { agentPageId, role, customRoleId, includeContext },
    });

    return NextResponse.json({ success: true, member: updated });
  } catch (error) {
    loggers.api.error('Error updating drive agent member:', error as Error);
    return NextResponse.json({ error: 'Failed to update agent member' }, { status: 500 });
  }
}

/**
 * DELETE /api/drives/{driveId}/agents/{agentPageId}
 * Remove an agent from drive membership
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; agentPageId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, agentPageId } = await context.params;

    const access = await checkDriveAccess(driveId, userId);
    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can remove agent members' }, { status: 403 });
    }

    // Verify membership exists
    const existing = await db
      .select({ id: driveAgentMembers.id })
      .from(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, driveId), eq(driveAgentMembers.agentPageId, agentPageId)))
      .limit(1);

    if (existing.length === 0) {
      return NextResponse.json({ error: 'Agent member not found' }, { status: 404 });
    }

    await db
      .delete(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, driveId), eq(driveAgentMembers.agentPageId, agentPageId)));

    auditRequest(request, {
      eventType: 'authz.permission.revoked',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { agentPageId },
    });

    return NextResponse.json({ success: true, message: 'Agent member removed successfully' });
  } catch (error) {
    loggers.api.error('Error removing drive agent member:', error as Error);
    return NextResponse.json({ error: 'Failed to remove agent member' }, { status: 500 });
  }
}
