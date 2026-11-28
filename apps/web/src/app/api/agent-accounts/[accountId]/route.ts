import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { updateAgentAccountBody } from '@/lib/agent-accounts/account-request-schemas';
import { changeResponse, stepUpProofFor } from '@/lib/agent-accounts/account-change-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ accountId: string }> };

/**
 * GET /api/agent-accounts/[accountId]
 * The account's permissions as the person who manages it sees them: its sites, whether calls run without
 * asking (and the hourly cap and end), this hour's use, the agents it is attached to, and unattended-run
 * delegations. Never the key, never versions. 404 for anyone who cannot manage it.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { accountId } = await context.params;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  try {
    const actor = actorFromAuth(auth);
    return await changeResponse(actor, await authority.describeAccount({ actor, accountId }));
  } catch (error) {
    loggers.api.error('Error reading agent account settings', error as Error);
    return NextResponse.json({ error: 'Failed to read account' }, { status: 500 });
  }
}

/**
 * PATCH /api/agent-accounts/[accountId]
 * Change the account's sites and "allow without asking". Narrowing applies at once; anything that widens
 * (a new site, turning it on, a higher cap, a later end) answers 401 `step_up_required` until the request
 * carries a step-up grant bound to this account.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { accountId } = await context.params;
  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  const parsed = updateAgentAccountBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const stepUp = await stepUpProofFor({ userId: auth.userId, accountId, token: parsed.data.stepUpToken });
    if (!stepUp.ok) return stepUp.response;
    const actor = actorFromAuth(auth);
    const result = await authority.updateAccount({ actor, accountId, edit: { allowedOrigins: parsed.data.allowedOrigins, autoApprove: parsed.data.autoApprove }, stepUp: stepUp.proof });
    if (result.ok) auditRequest(request, { eventType: 'authz.permission.granted', userId: auth.userId, resourceType: 'agent_account', resourceId: accountId, details: { change: 'permissions', steppedUp: stepUp.proof !== null } });
    return await changeResponse(actor, result);
  } catch (error) {
    loggers.api.error('Error updating agent account', error as Error);
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}
