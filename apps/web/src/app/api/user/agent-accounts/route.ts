import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { UserId } from '@pagespace/lib/agent-accounts/grant';
import { getAccountAuthority } from '@/lib/agent-accounts/account-authority-client';
import { CREATE_REFUSAL_STATUS, createAgentAccountBody } from '@/lib/agent-accounts/account-request-schemas';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/user/agent-accounts
 * The caller's own accounts (used by their global assistant), as SafeAccount only.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'agent_accounts', resourceId: 'self' });

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ configured: false, accounts: [] });
  try {
    const accounts = await authority.listAccounts({ actorUserId: auth.userId as UserId, owner: { kind: 'user' } });
    return NextResponse.json({ configured: true, accounts: accounts ?? [] });
  } catch (error) {
    loggers.api.error('Error listing agent accounts', error as Error);
    return NextResponse.json({ error: 'Failed to list accounts' }, { status: 500 });
  }
}

/**
 * POST /api/user/agent-accounts
 * Add an account for the caller's global assistant. The key goes to the credential plane and is never returned.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const authority = getAccountAuthority();
  if (authority === null) return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const parsed = createAgentAccountBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  try {
    const result = await authority.createAccount({ actorUserId: auth.userId as UserId, owner: { kind: 'user' }, input: parsed.data });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: CREATE_REFUSAL_STATUS[result.reason] ?? 400 });
    auditRequest(request, { eventType: 'auth.token.created', userId: auth.userId, resourceType: 'agent_account', resourceId: result.account.id });
    return NextResponse.json({ account: result.account }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating agent account', error as Error);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}
