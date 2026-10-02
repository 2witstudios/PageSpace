import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { toolApprovalRepository } from '@/lib/repositories/tool-approval-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/user/assistant-config/tool-grants
 * The caller's standing tool-approval grants ("allow for this conversation" and
 * "always allow"), for the settings surface. Always scoped to the caller.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'tool_approval_grant', resourceId: 'self' });

  try {
    const grants = await toolApprovalRepository.listAllGrants(auth.userId);
    return NextResponse.json({
      grants: grants.map((grant) => ({
        id: grant.id,
        toolName: grant.toolName,
        conversationId: grant.conversationId,
        createdAt: grant.createdAt,
      })),
    });
  } catch (error) {
    loggers.api.error('Error listing tool approval grants:', error as Error);
    return NextResponse.json({ error: 'Failed to list grants' }, { status: 500 });
  }
}

const deleteSchema = z.object({ grantId: z.string().min(1).max(64) });

/**
 * DELETE /api/user/assistant-config/tool-grants
 * Revoke one grant. The repository filters by owner, so another user's grant
 * id is simply not found — never revoked.
 */
export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const body = await request.json().catch(() => null);
    const validation = deleteSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'grantId is required' }, { status: 400 });
    }

    const revoked = await toolApprovalRepository.revokeGrant({ userId: auth.userId, grantId: validation.data.grantId });
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'tool_approval_grant',
      resourceId: validation.data.grantId,
      details: { action: 'revoke', revoked },
    });
    if (!revoked) return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    loggers.api.error('Error revoking tool approval grant:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke grant' }, { status: 500 });
  }
}
