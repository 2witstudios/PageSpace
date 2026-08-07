/**
 * A session's persisted pane grid — READ ONLY. Every mutation goes through
 * `./verbs` (`POST {opId, baseRev, verb}`); this route no longer accepts
 * writes at all.
 *
 * GET  → 200 { workspace: PersistedWorkspaceState | null, rev, grid }
 *   `rev`/`grid` are the relational truth: the grid derives from the pane
 *   ROWS with display labels JOINed at read time. `workspace` is the SAME
 *   grid packaged in the older whole-state shape a pre-verbs client expects
 *   — it is no longer a stored blob (the `agent_workspaces.workspaceState`
 *   column was dropped at Phase 3's contract step), just a projection, and
 *   its two view-state fields carry defaults rather than restored facts
 *   (focus is client-local per #2048). `grid: null` + `rev: 0` for a session
 *   with no grid OR one the requester cannot reach — SAME answer either way
 *   (family policy, review #2261/5): a probe learns nothing from the
 *   difference between "doesn't exist" and "not yours".
 *
 * PUT → 410 Gone.
 *   The whole-grid blob write is retired. 410 rather than a silent 200 or a
 *   bare 404/405 on purpose: a stale deployed client (pre-#2345, when
 *   `useWorkspaceServerSync` still debounced a PUT here) must NOT be told its
 *   layout saved when nothing was stored, and 410 says precisely "this
 *   endpoint existed and is permanently retired" where a 404 reads as a
 *   routing bug and a 405 as a typo'd method. The handler still runs auth +
 *   `checkSessionAccess` first so the retirement notice is not itself a
 *   session-existence oracle.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkSessionAccess } from '@/lib/agent-workspaces/agent-sessions-runtime';
import {
  readWorkspaceLayoutSnapshot,
  workspaceListEntryFromGrid,
} from '@/lib/agent-workspaces/workspace-layout-runtime';
import { auditSessionAccessDenial, sessionNotFoundOrDenied } from '@/lib/agent-workspaces/session-unavailable-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/workspace';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    auditSessionAccessDenial(request, auth.userId, workspaceId, access.reason, ROUTE);
    return NextResponse.json({ workspace: null, rev: 0, grid: null });
  }

  const snapshot = await readWorkspaceLayoutSnapshot(workspaceId, auth.userId);
  return NextResponse.json({
    workspace: workspaceListEntryFromGrid(workspaceId, snapshot.grid),
    rev: snapshot.rev,
    grid: snapshot.grid,
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  return NextResponse.json(
    { error: 'The workspace blob PUT is retired — post layout verbs to /workspace/verbs instead.' },
    { status: 410 },
  );
}
