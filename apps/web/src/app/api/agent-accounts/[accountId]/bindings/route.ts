import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { bindAgentAccountBody } from '@/lib/agent-accounts/account-request-schemas';
import { changeResponse, stepUpProofFor } from '@/lib/agent-accounts/account-change-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ accountId: string }> };

/**
 * POST /api/agent-accounts/[accountId]/bindings
 * Attach one of YOUR accounts to an agent you can edit, so that agent can use it when YOU run it. It never
 * lets anyone else use the account. Always widening: answers 401 `step_up_required` until the request
 * carries a step-up grant bound to this account.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { accountId } = await context.params;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = bindAgentAccountBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const stepUp = await stepUpProofFor({ userId: auth.userId, accountId, token: parsed.data.stepUpToken });
    if (!stepUp.ok) return stepUp.response;
    const actor = actorFromAuth(auth);
    const result = await authority.bindAccount({ actor, accountId, agentPageId: parsed.data.agentPageId, stepUp: stepUp.proof });
    // Every step-up widening is audited, applied or not: the plane may hold it even when the row write failed.
    if (result.ok || stepUp.proof !== null) auditRequest(request, { eventType: 'authz.permission.granted', userId: auth.userId, resourceType: 'agent_account', resourceId: accountId, details: { change: 'bind', agentPageId: parsed.data.agentPageId, steppedUp: stepUp.proof !== null, outcome: result.ok ? 'applied' : result.reason } });
    return await changeResponse(actor, result);
  } catch (error) {
    loggers.api.error('Error binding agent account', error as Error);
    return NextResponse.json({ error: 'Failed to attach account' }, { status: 500 });
  }
}
