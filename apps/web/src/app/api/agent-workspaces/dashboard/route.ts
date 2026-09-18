/**
 * The DASHBOARD WORKSPACE endpoint — the dashboard surface's layout tree,
 * get-or-create in one call.
 *
 *   GET 200 { workspaceId, created, rev, nodes, targets }
 *
 * Idempotent by design: the first dashboard visit provisions the workspace
 * (row + rev + a single chat pane seeded with the caller's active global
 * conversation, when legal — see `getOrCreateDashboardWorkspace`), every later
 * visit reads the same tree. The response nests the node snapshot with the
 * SAME shape `GET /api/agent-workspaces/[workspaceId]/nodes` answers, so a
 * client seats a provisioned tree and a returned one through one code path.
 *
 * This is a GET with create side effects, deliberately — the same lazy
 * provisioning pattern the Home drive uses. Creation is bounded by the
 * `agent_workspaces_one_open_dashboard_idx` partial unique index (one OPEN
 * dashboard per owner), which is also the concurrency arbiter: two tabs
 * racing the first visit both get 200 and one tree.
 *
 * `?conversationId=` seeds the first pane's binding. Never trusted: ownership
 * is checked against the caller, and a conversation already bound to a node
 * anywhere leaves the pane unbound (membership moves by fork, never rebind).
 *
 * Access: owner-only by construction — a dashboard workspace has no drive
 * (`driveId` NULL), so `decideAgentSessionAccess`'s global branch applies to
 * every later read of the workspace through the ordinary session routes.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getOrCreateDashboardWorkspace } from '@/lib/agent-workspaces/dashboard-workspace-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };

const ROUTE = 'agent-workspaces/dashboard';

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const rawConversationId = url.searchParams.get('conversationId');
  const conversationId =
    rawConversationId !== null && rawConversationId.length > 0 ? rawConversationId : null;

  try {
    const result = await getOrCreateDashboardWorkspace(auth.userId, conversationId);
    if (!result.ok) {
      return NextResponse.json({ error: 'Could not provision the dashboard' }, { status: 500 });
    }

    if (result.workspace.created) {
      auditRequest(request, {
        eventType: 'data.write',
        userId: auth.userId,
        resourceType: 'agent_session',
        resourceId: result.workspace.workspaceId,
        details: {
          op: 'dashboard_workspace_provision',
          seededConversationId: conversationId,
        },
      });
    }

    return NextResponse.json({
      workspaceId: result.workspace.workspaceId,
      created: result.workspace.created,
      ...result.workspace.snapshot,
    });
  } catch (error) {
    loggers.api.error(
      'Dashboard workspace provision failed',
      error instanceof Error ? error : undefined,
      { route: ROUTE },
    );
    return NextResponse.json({ error: 'Could not provision the dashboard' }, { status: 500 });
  }
}
