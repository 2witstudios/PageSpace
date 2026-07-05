import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { removeAgentFromDrive, setAgentDriveIncludeContext } from '@pagespace/lib/services/drive-agent-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const patchBodySchema = z.object({
  includeContext: z.boolean(),
});

/**
 * PATCH /api/ai/page-agents/[agentId]/drives/[driveId]
 * Toggle whether this membership's drive carries its drivePrompt into the
 * agent's system prompt.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ agentId: string; driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { agentId, driveId } = await context.params;

    const parsed = patchBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const result = await setAgentDriveIncludeContext({
      actingUserId: userId,
      agentPageId: agentId,
      driveId,
      includeContext: parsed.data.includeContext,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(request, {
      eventType: 'authz.role.assigned',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { agentPageId: agentId, includeContext: parsed.data.includeContext },
    });

    return NextResponse.json({ success: true, member: result.member });
  } catch (error) {
    loggers.api.error('Error updating agent drive membership context:', error as Error);
    return NextResponse.json({ error: 'Failed to update agent drive membership' }, { status: 500 });
  }
}

/**
 * DELETE /api/ai/page-agents/[agentId]/drives/[driveId]
 * Remove this agent's membership in a drive. The home drive cannot be removed.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { agentId, driveId } = await context.params;

    const result = await removeAgentFromDrive({
      actingUserId: userId,
      agentPageId: agentId,
      driveId,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(request, {
      eventType: 'authz.permission.revoked',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { agentPageId: agentId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error removing agent from drive:', error as Error);
    return NextResponse.json({ error: 'Failed to remove agent from drive' }, { status: 500 });
  }
}
