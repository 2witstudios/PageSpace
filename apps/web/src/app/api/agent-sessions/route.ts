/**
 * Agent Sessions list API — ONE flat route family (`/api/agent-sessions/**`),
 * deliberately NOT nested under page-agents/conversations: the session row
 * knows its agent (`agentPageId`), so auth derives from the row, and the
 * sessionId in every deeper segment IS the conversation id (contract.ts
 * invariant 1 — there is no second id to nest by).
 *
 * GET ?driveId=<id> | ?agentId=<id> | (none = mine)
 *   → { sessions: [{ …AgentSessionDTO, shells: ShellDTO[] }] }
 *
 * Every listing is scoped to the REQUESTER's own sessions (`ownerId` rides
 * every filter): `driveId`/`agentId` narrow *where*, never *whose*. Admin gate
 * first, 403 without enumerating anything — the agents surface is admin-only +
 * CODE_EXECUTION, same population `/api/machines` served.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { listSessions, type AgentSessionListFilter } from '@/lib/agent-sessions/agent-sessions-runtime';
import { listShells } from '@/lib/agent-sessions/session-shells-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const driveId = url.searchParams.get('driveId');

  if (auth.role !== 'admin') {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: driveId ? 'drive' : 'agent_sessions',
      resourceId: driveId ?? undefined,
      details: { reason: 'app_admin_required', method: 'GET', route: 'agent-sessions' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'Agent sessions require administrator privileges' }, { status: 403 });
  }

  // No agent filter exists any more: a session hosts conversations with MANY
  // agents, so "an agent's sessions" is not a real relation to query.
  const filter: AgentSessionListFilter =
    driveId !== null && driveId.length > 0
      ? { driveId, ownerId: auth.userId }
      : { ownerId: auth.userId };

  try {
    const sessions = await listSessions(filter);
    const withShells = await Promise.all(
      sessions.map(async (session) => ({
        ...session,
        shells: await listShells(session.sessionId),
      })),
    );
    return NextResponse.json({ sessions: withShells });
  } catch (error) {
    loggers.api.error(
      'Agent sessions list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list agent sessions' }, { status: 500 });
  }
}
