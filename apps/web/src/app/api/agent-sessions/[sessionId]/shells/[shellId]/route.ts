/**
 * One shell — kill it.
 *
 * DELETE → 200 { ok: true, killed } — terminate the PTY (if one was ever
 * launched) and drop the row; the session's SANDBOX is untouched. A shell that
 * does not exist (or lives under a different session than the URL claims) is a
 * 404, which the client treats as success — killing something already gone IS
 * success (`planKillTarget`), and the 404 leaks nothing because it is the same
 * answer an unauthorized prober gets for a shell they cannot see.
 *
 * Gated by the END access check (identity + page, no capability): closing a
 * tab must survive a lost `canRunCode`, same rule as ending the session.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkSessionEndAccess } from '@/lib/agent-sessions/agent-sessions-runtime';
import { killShellById, resolveShellById } from '@/lib/agent-sessions/session-shells-runtime';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ sessionId: string; shellId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { sessionId, shellId } = await context.params;

  const resolved = await resolveShellById(shellId);
  // A URL whose sessionId does not match the shell's actual session addresses
  // nothing — same 404 as a shell that never existed, so the pairing cannot be
  // probed.
  if (!resolved.ok || resolved.shell.sessionId !== sessionId) {
    return NextResponse.json({ error: 'Shell not found' }, { status: 404 });
  }

  const access = await checkSessionEndAccess(auth.userId, resolved.shell.sessionId);
  if (!access.allowed) {
    if (access.reason === 'session_not_found') {
      return NextResponse.json({ error: 'Shell not found' }, { status: 404 });
    }
    auditRequest(request, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: sessionId,
      details: { reason: access.reason, route: 'agent-sessions/[sessionId]/shells/[shellId]', shellId },
      riskScore: 0.5,
    });
    return NextResponse.json({ error: 'You do not have access to this session' }, { status: 403 });
  }

  const killed = await killShellById(shellId);
  if (!killed.ok) {
    loggers.api.error('Shell kill failed', undefined, { sessionId, shellId });
    return NextResponse.json({ error: 'Could not close this shell', reason: killed.reason }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: sessionId,
    details: { op: 'kill_shell', shellId, killed: killed.killed },
  });

  return NextResponse.json({ ok: true, killed: killed.killed });
}
