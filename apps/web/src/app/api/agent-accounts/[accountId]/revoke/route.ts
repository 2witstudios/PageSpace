import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { UserId } from '@pagespace/lib/agent-accounts/grant';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ accountId: string }> };

/**
 * POST /api/agent-accounts/[accountId]/revoke
 * Stop PageSpace from ever using this account again (broker-denied at the credential plane). This does
 * NOT revoke the key at the provider — the response says so, and the UI tells the person to do it there.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { accountId } = await context.params;

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  try {
    const result = await authority.revokeAccount({ actorUserId: auth.userId as UserId, accountId });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.reason === 'plane_unavailable' ? 503 : 404 });
    auditRequest(request, { eventType: 'auth.token.revoked', userId: auth.userId, resourceType: 'agent_account', resourceId: accountId });
    return NextResponse.json({ account: result.account, upstreamRevoked: false });
  } catch (error) {
    loggers.api.error('Error revoking agent account', error as Error);
    return NextResponse.json({ error: 'Failed to revoke account' }, { status: 500 });
  }
}
