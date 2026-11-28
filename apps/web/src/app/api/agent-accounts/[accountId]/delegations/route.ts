import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { createDelegationBody } from '@/lib/agent-accounts/account-request-schemas';
import { changeResponse, stepUpProofFor } from '@/lib/agent-accounts/account-change-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ accountId: string }> };

/**
 * POST /api/agent-accounts/[accountId]/delegations
 * Let scheduled runs and workflows that YOU start on this agent use the account for `days` (1–90), within its current "allow without asking" reach — they cannot answer an approval prompt. Needs
 * step-up (401 `step_up_required` until the request carries a grant bound to this account).
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { accountId } = await context.params;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = createDelegationBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const stepUp = await stepUpProofFor({ userId: auth.userId, accountId, token: parsed.data.stepUpToken });
    if (!stepUp.ok) return stepUp.response;
    const actor = actorFromAuth(auth);
    const expiresAt = Date.now() + parsed.data.days * 86_400_000;
    const result = await authority.createDelegation({ actor, accountId, agentPageId: parsed.data.agentPageId, expiresAt, stepUp: stepUp.proof });
    if (result.ok) auditRequest(request, { eventType: 'authz.permission.granted', userId: auth.userId, resourceType: 'agent_account', resourceId: accountId, details: { change: 'delegate', agentPageId: parsed.data.agentPageId, expiresAt } });
    return await changeResponse(actor, result);
  } catch (error) {
    loggers.api.error('Error delegating agent account', error as Error);
    return NextResponse.json({ error: 'Failed to allow unattended use' }, { status: 500 });
  }
}
