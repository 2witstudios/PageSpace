import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { removeAgentFromDrive } from '@pagespace/lib/services/drive-agent-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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
