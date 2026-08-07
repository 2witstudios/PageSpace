/**
 * Agent workspace layout verbs (epic Phase 3 — the #2202 pattern).
 *
 * POST { opId, baseRev, verb } → one ordered, idempotent mutation over the
 * session's relational pane grid, applied by the shared reducer under the
 * per-workspace lock (`workspace-layout-runtime.ts`). It REPLACED the blob PUT
 * on `../route.ts`, which is now a bare 410 — there is no reconcile left, and
 * no second writer to disagree with.
 *
 *   200 { rev, grid, applied } — the op landed (or replayed, or no-oped;
 *       `applied` is the content diff's verdict, and decides the broadcast).
 *   409 { rev, grid }          — stale `baseRev`; the body is the truth to
 *       rebase against, not an error to surrender to.
 *
 * Gated by the same session-access check the blob PUT uses, with the same
 * family policy: an unknown session and a denied session answer the SAME 404
 * (`sessionNotFoundOrDenied`) so a probe learns nothing from the difference.
 *
 * SESSION ACCESS IS NOT TARGET ACCESS (security review HIGH 1, attack B).
 * Reaching a workspace says nothing about the `scope.targetId` a verb wants to
 * bind into it — that id is free-form in the body — so a second gate
 * (`authorizeVerbScopes`) settles the target before the engine ever sees it:
 *
 *   403 { error }              — the caller may use this workspace but not
 *       show that target in it. Uniform across "forbidden" and "no such
 *       target", so a caller probing ids learns nothing.
 */

import { NextResponse } from 'next/server';
import type {
  WorkspaceLayoutStaleResponse,
  WorkspaceLayoutVerbResponse,
} from '@pagespace/lib/agent-workspaces/workspace-layout-wire';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { workspaceLayoutVerbSchema } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { checkSessionAccess } from '@/lib/agent-workspaces/agent-sessions-runtime';
import { applyWorkspaceLayoutVerb } from '@/lib/agent-workspaces/workspace-layout-runtime';
import { authorizeVerbScopes } from '@/lib/agent-workspaces/authorize-pane-scope';
import { sessionNotFoundOrDenied } from '@/lib/agent-workspaces/session-unavailable-response';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/workspace/verbs';

const bodySchema = z.object({
  /** Client-minted idempotency key — a retried POST with the same opId replays as a no-op. */
  opId: z.string().min(1).max(128),
  /** The rev the client reduced against; anything but the current rev answers 409 + truth. */
  baseRev: z.number().int().min(0),
  verb: workspaceLayoutVerbSchema,
});

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return sessionNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'opId, baseRev, and verb are required' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid verb payload', issues: parsed.error.issues }, { status: 400 });
  }

  // The target gate runs on the PARSED verb — after the shape is known and
  // after session access is settled, so a probe cannot use it to distinguish
  // "workspace you cannot reach" from "target you cannot bind".
  const scopesAllowed = await authorizeVerbScopes({
    viewerId: auth.userId,
    workspaceId,
    verb: parsed.data.verb,
  });
  if (!scopesAllowed) {
    return NextResponse.json({ error: 'You cannot show that in this workspace.' }, { status: 403 });
  }

  let result;
  try {
    result = await applyWorkspaceLayoutVerb({
      workspaceId: workspaceId,
      opId: parsed.data.opId,
      baseRev: parsed.data.baseRev,
      verb: parsed.data.verb,
      // Labels on the way out are resolved for THIS caller alone; the
      // broadcast that follows carries none at all.
      viewerId: auth.userId,
    });
  } catch (error) {
    loggers.api.error('Workspace layout verb failed', error instanceof Error ? error : undefined, { workspaceId });
    return NextResponse.json({ error: 'Could not apply the layout verb' }, { status: 502 });
  }

  if (result.status === 'stale') {
    // Typed against the shared wire shape, so the store parses exactly what
    // this returns — including the ABSENCE of `applied` on a 409.
    const stale: WorkspaceLayoutStaleResponse = { rev: result.rev, grid: result.grid };
    return NextResponse.json(stale, { status: 409 });
  }

  if (result.applied) {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: workspaceId,
      details: { op: 'workspace_layout_verb', verb: parsed.data.verb.type, rev: result.rev },
    });
  }

  const ok: WorkspaceLayoutVerbResponse = { rev: result.rev, grid: result.grid, applied: result.applied };
  return NextResponse.json(ok);
}
