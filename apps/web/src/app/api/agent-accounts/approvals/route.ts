import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { UserId } from '@pagespace/lib/agent-accounts/grant';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { approveAgentAccountRequestBody } from '@/lib/agent-accounts/account-request-schemas';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/agent-accounts/approvals
 * A person approves ONE exact request (its digest) once. The decision arrives here from the human's own
 * authenticated session — never from model text (ADR 0004 §4.3) — and the next identical request consumes it.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  if (auth.tokenType !== 'session') return NextResponse.json({ error: 'session_required' }, { status: 403 });

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const parsed = approveAgentAccountRequestBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  try {
    const result = await authority.approveRequest({ actorUserId: auth.userId as UserId, sessionId: auth.sessionId, accountId: parsed.data.accountId, requestDigest: parsed.data.requestDigest });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 404 });
    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'agent_account_approval', resourceId: result.approvalId });
    return NextResponse.json({ approvalId: result.approvalId, expiresAt: result.expiresAt }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error approving agent account request', error as Error);
    return NextResponse.json({ error: 'Failed to approve request' }, { status: 500 });
  }
}
