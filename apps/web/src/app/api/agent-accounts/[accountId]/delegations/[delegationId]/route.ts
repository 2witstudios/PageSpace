import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { changeResponse } from '@/lib/agent-accounts/account-change-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ accountId: string; delegationId: string }> };

/** DELETE /api/agent-accounts/[accountId]/delegations/[delegationId] — stop unattended use now. No step-up. */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { accountId, delegationId } = await context.params;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  try {
    const actor = actorFromAuth(auth);
    const result = await authority.revokeDelegation({ actor, accountId, delegationId });
    if (result.ok) auditRequest(request, { eventType: 'authz.permission.revoked', userId: auth.userId, resourceType: 'agent_account', resourceId: accountId, details: { change: 'undelegate', delegationId } });
    return await changeResponse(actor, result);
  } catch (error) {
    loggers.api.error('Error revoking agent account delegation', error as Error);
    return NextResponse.json({ error: 'Failed to stop unattended use' }, { status: 500 });
  }
}
