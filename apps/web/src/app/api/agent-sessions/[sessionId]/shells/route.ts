/**
 * A session's shells — the named PTYs inside its ONE shared sandbox.
 *
 * GET  → 200 { shells: ShellDTO[] } — a session with no row yet has no shells
 *   ({ shells: [] }), same "cold is a normal answer" rule as the session GET.
 *
 * POST { name? } → 201 { shell: ShellDTO } — reserve a shell row. On a COLD
 *   session this lazily ensures the session row AND provisions the sandbox
 *   first (opening a shell is the second of the two sanctioned first-touch
 *   provisioning sites; the other is the first sandbox tool call). An absent
 *   name auto-labels `shell-N` via the pure `planSpawnShell`; a requested
 *   duplicate is a 409, never a silent rename.
 *
 * The PTY itself is NOT started here — the realtime bridge opens it lazily on
 * first connect ({ shellId } is the whole connect payload, contract.ts).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { sessionAnchorForConversation } from '@/lib/agent-sessions/session-anchor';
import {
  checkAccessForSubject,
  checkSessionAccess,
  ensureSession,
  findSessionConversation,
  provisionSessionSandbox,
} from '@/lib/agent-sessions/agent-sessions-runtime';
import { listShells, spawnShell } from '@/lib/agent-sessions/session-shells-runtime';
import { sessionQuotaExceeded } from '@/lib/agent-sessions/quota-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ sessionId: string }> };


function denied(request: Request, userId: string, sessionId: string, reason: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { reason, route: 'agent-sessions/[sessionId]/shells' },
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  const access = await checkSessionAccess(auth.userId, sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') return NextResponse.json({ shells: [] });
    return denied(request, auth.userId, sessionId, access.reason);
  }

  return NextResponse.json({ shells: await listShells(sessionId) });
}

const SPAWN_DENIAL_STATUS: Record<string, number> = {
  invalid_name: 400,
  name_taken: 409,
  invalid_agent_type: 400,
  invalid_command: 400,
  error: 500,
};

const SPAWN_DENIAL_MESSAGE: Record<string, string> = {
  invalid_name: 'That is not a valid shell name — use letters, digits, "-" and "_", starting with a letter or digit',
  name_taken: 'A shell with that name already exists in this session',
  invalid_agent_type: 'That shell type is not available',
  invalid_command: 'That shell command is not valid',
  error: 'Could not open a shell',
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId } = await context.params;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // An empty body opens a shell with an auto-label — one act, not a naming step.
  }
  const rawName = body !== null && typeof body === 'object' ? (body as { name?: unknown }).name : undefined;
  if (rawName !== undefined && typeof rawName !== 'string') {
    return NextResponse.json({ error: 'name must be a string' }, { status: 400 });
  }

  const conversation = await findSessionConversation(sessionId);
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const anchor = sessionAnchorForConversation(conversation);
  if (!anchor.ok) {
    return NextResponse.json(
      { error: 'This conversation cannot host an agent session', reason: anchor.reason },
      { status: 409 },
    );
  }

  const access = await checkAccessForSubject(auth.userId, {
    sessionId,
    ownerId: conversation.userId,
    agentPageId: anchor.agentPageId,
  });
  if (!access.allowed) return denied(request, auth.userId, sessionId, access.reason);

  // A shell needs a sandbox to run in: cold sessions lazily acquire theirs
  // HERE, through the same one provisioning path every surface shares.
  const ensured = await ensureSession({
    conversationId: sessionId,
    userId: conversation.userId,
    agentPageId: anchor.agentPageId,
  });
  if (!ensured.ok) {
    return NextResponse.json(
      { error: 'This conversation cannot host an agent session', reason: ensured.reason },
      { status: 409 },
    );
  }

  const provisioned = await provisionSessionSandbox(ensured.session, auth.userId);
  if (!provisioned.ok) {
    if (provisioned.reason === 'denied') {
      // A plan-limit refusal is not an access denial — separate response and
      // separate audit event (see quotaExceeded).
      if (provisioned.denial === 'session_limit_reached') {
        return sessionQuotaExceeded(request, auth.userId, sessionId, 'agent-sessions/[sessionId]/shells', provisioned.detail);
      }
      return denied(request, auth.userId, sessionId, provisioned.denial ?? 'denied');
    }
    loggers.api.error('Shell spawn: session sandbox provision failed', undefined, {
      sessionId,
      reason: provisioned.reason,
      detail: provisioned.detail,
    });
    return NextResponse.json(
      { error: 'Could not provision a sandbox for this session', reason: provisioned.reason },
      { status: 502 },
    );
  }

  const spawned = await spawnShell({ sessionId, ownerId: auth.userId, name: rawName });
  if (!spawned.ok) {
    return NextResponse.json(
      {
        // Same split the tool surface draws: with no requested name, a
        // `name_taken` can only mean a concurrent spawn won the auto-label
        // race, and "a shell with that name already exists" names a name the
        // caller never chose.
        error:
          spawned.reason === 'name_taken' && rawName === undefined
            ? 'Another shell was created at the same moment. Try again.'
            : SPAWN_DENIAL_MESSAGE[spawned.reason],
        reason: spawned.reason,
      },
      { status: SPAWN_DENIAL_STATUS[spawned.reason] ?? 500 },
    );
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'spawn_shell', shellId: spawned.shell.shellId, name: spawned.shell.name },
  });

  return NextResponse.json({ shell: spawned.shell }, { status: 201 });
}
