/**
 * Agent Sessions API — ONE flat route family (`/api/agent-sessions/**`),
 * deliberately NOT nested under page-agents/conversations: a session is a
 * DRIVE-level workspace hosting many conversations (contract.ts invariant 1),
 * so no single agent or conversation exists to nest it under. Auth derives
 * from the session row's drive.
 *
 * GET ?driveId=<id> | (none = mine)
 *   → { sessions: [{ …AgentSessionDTO, shells: ShellDTO[], conversations }] }
 * POST { driveId, agentPageId, name? }
 *   → 201 { session, conversationId } — spawn (see below)
 *
 * Every listing is scoped to the REQUESTER's own sessions (`ownerId` rides
 * every filter): `driveId` narrows *where*, never *whose*. Admin gate
 * first, 403 without enumerating anything — the agents surface is admin-only +
 * CODE_EXECUTION, same population `/api/machines` served.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createId } from '@paralleldrive/cuid2';
import {
  checkAccessForSubject,
  createConversationInSession,
  endSession,
  listSessions,
  listSessionConversations,
  spawnSession,
  toAgentSessionDTO,
  type AgentSessionListFilter,
} from '@/lib/agent-sessions/agent-sessions-runtime';
import { listShells } from '@/lib/agent-sessions/session-shells-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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
    const withChildren = await Promise.all(
      sessions.map(async (session) => ({
        ...session,
        shells: await listShells(session.sessionId),
        // The sidebar's expansion list: the threads living in this workspace.
        conversations: await listSessionConversations(session.sessionId),
      })),
    );
    return NextResponse.json({ sessions: withChildren });
  } catch (error) {
    loggers.api.error(
      'Agent sessions list failed',
      error instanceof Error ? error : undefined,
      { driveId },
    );
    return NextResponse.json({ error: 'Failed to list agent sessions' }, { status: 500 });
  }
}

/**
 * POST → 201 { session, conversationId } — SPAWN a session.
 *
 * One act, per the lifecycle invariant: a session is born with its first
 * conversation, so this creates the workspace row AND a conversation already
 * bound to it. The conversation's agent is the caller's choice (`agentPageId`;
 * omitted/null is reserved for the global assistant, which this route refuses
 * until its identity path lands — the client's picker does not offer it).
 *
 * Spawn is instant and free: NO sandbox is provisioned here. The first tool
 * call or shell open provisions lazily through the one shared path.
 *
 * Access: spawning into a drive requires drive membership + the code-execution
 * capability — the same pure decision every session surface uses, applied to
 * the row-to-be.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { driveId?: unknown; agentPageId?: unknown; name?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Body is required — a spawn names its drive and agent.
  }
  const driveId = typeof body.driveId === 'string' && body.driveId.length > 0 ? body.driveId : null;
  const agentPageId =
    typeof body.agentPageId === 'string' && body.agentPageId.length > 0 ? body.agentPageId : null;
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : null;

  if (driveId === null || agentPageId === null) {
    // Global-assistant sessions (null drive) are Phase R2's identity work;
    // until then a spawn is always drive-scoped with a concrete agent.
    return NextResponse.json(
      { error: 'A session needs a drive and an agent to start with' },
      { status: 400 },
    );
  }

  const access = await checkAccessForSubject(auth.userId, {
    sessionId: 'about-to-be-minted',
    ownerId: auth.userId,
    driveId,
  });
  if (!access.allowed) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: driveId,
      details: { reason: access.reason, method: 'POST', route: 'agent-sessions' },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'You cannot start a session in this drive' }, { status: 403 });
  }

  const spawned = await spawnSession({ userId: auth.userId, driveId, name });
  if (!spawned.ok) {
    loggers.api.error('Agent session spawn failed', undefined, { driveId, detail: spawned.detail });
    return NextResponse.json({ error: 'Could not start a session', reason: spawned.reason }, { status: 502 });
  }

  // The first conversation — the session is never empty. Created through the
  // squat-guarded path, already bound to the session.
  const conversationId = createId();
  try {
    await createConversationInSession({
      conversationId,
      userId: auth.userId,
      agentPageId,
      sessionId: spawned.session.id,
    });
  } catch (error) {
    // The session row exists but its first conversation failed: end it rather
    // than leave an empty workspace the model says cannot exist.
    await endSession(spawned.session.id).catch(() => {});
    loggers.api.error(
      'Agent session spawn: first conversation failed',
      error instanceof Error ? error : undefined,
      { sessionId: spawned.session.id },
    );
    return NextResponse.json({ error: 'Could not start a session' }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: spawned.session.id,
    details: { op: 'spawn_session', driveId, agentPageId, conversationId },
  });

  return NextResponse.json(
    { session: toAgentSessionDTO(spawned.session), conversationId },
    { status: 201 },
  );
}
