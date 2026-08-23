/**
 * One shell — kill it.
 *
 * DELETE → 200 { ok: true, killed } — terminate the PTY (if one was ever
 * launched), drop the row, and REMOVE THE PANE bound to it, all in one
 * transaction; the session's SANDBOX is untouched. The pane's removal is what
 * makes this the inverse of the spawn (issue #2462): it broadcasts, so every
 * browser watching the workspace loses the tab, rather than each of them
 * keeping a pane bound to a terminal that no longer exists. A shell that
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
import { checkSessionEndAccess } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { killShellById, resolveShellById } from '@/lib/agent-workspaces/workspace-shells-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/shells/[shellId]';

type RouteContext = { params: Promise<{ workspaceId: string; shellId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId, shellId } = await context.params;

  const resolved = await resolveShellById(shellId);
  // A URL whose workspaceId does not match the shell's actual session addresses
  // nothing — same 404 as a shell that never existed, so the pairing cannot be
  // probed.
  if (!resolved.ok || resolved.shell.workspaceId !== workspaceId) {
    return NextResponse.json({ error: 'Shell not found' }, { status: 404 });
  }

  // Not found and denied answer THE SAME 404 (family policy, review #2261/5)
  // — "Shell not found" for both, so a caller cannot distinguish "no such
  // shell" from "not yours".
  const access = await checkSessionEndAccess(auth.userId, resolved.shell.workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE, 'Shell not found');
  }

  // The acting human, carried into the membership write the kill now performs:
  // the pane bound to this shell goes with the process, in the same transaction.
  const killed = await killShellById({ shellId, actingUserId: auth.userId });
  if (!killed.ok) {
    loggers.api.error('Shell kill failed', undefined, { workspaceId, shellId });
    return NextResponse.json({ error: 'Could not close this shell', reason: killed.reason }, { status: 502 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'agent_session',
    resourceId: workspaceId,
    details: { op: 'kill_shell', shellId, killed: killed.killed },
  });

  return NextResponse.json({ ok: true, killed: killed.killed });
}
