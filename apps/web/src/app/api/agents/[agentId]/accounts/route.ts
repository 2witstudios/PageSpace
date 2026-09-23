import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { UserId } from '@pagespace/lib/agent-accounts/grant';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { CREATE_REFUSAL_STATUS, createAgentAccountBody } from '@/lib/agent-accounts/account-request-schemas';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/accounts
 * The agent page's own accounts, for a caller with `view` on them (drive owner/admin, or a member who can edit the page).
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { agentId } = await context.params;
  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'agent_accounts', resourceId: agentId });

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ configured: false, accounts: [] });
  try {
    const accounts = await authority.listAccounts({ actorUserId: auth.userId as UserId, owner: { kind: 'agent_page', agentPageId: agentId } });
    if (accounts === null) return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    return NextResponse.json({ configured: true, accounts });
  } catch (error) {
    loggers.api.error('Error listing agent page accounts', error as Error);
    return NextResponse.json({ error: 'Failed to list accounts' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[agentId]/accounts
 * Add an account owned by this agent page. Drive owners and admins only; the key goes to the credential plane.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { agentId } = await context.params;

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const parsed = createAgentAccountBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  try {
    const result = await authority.createAccount({ actorUserId: auth.userId as UserId, owner: { kind: 'agent_page', agentPageId: agentId }, input: parsed.data });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: CREATE_REFUSAL_STATUS[result.reason] ?? 400 });
    auditRequest(request, { eventType: 'auth.token.created', userId: auth.userId, resourceType: 'agent_account', resourceId: result.account.id });
    return NextResponse.json({ account: result.account }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating agent page account', error as Error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
