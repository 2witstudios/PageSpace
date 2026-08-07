/**
 * Agent workspace layout verbs (epic Phase 3 — the #2202 pattern).
 *
 * POST { opId, baseRev, verb } → one ordered, idempotent mutation over the
 * session's relational pane grid, applied by the shared reducer under the
 * per-workspace lock (`workspace-layout-runtime.ts`). Successor to the blob
 * PUT on `../route.ts` (kept there as a rolling-deploy shim; it reconciles
 * blob→rows through the same projection).
 *
 *   200 { rev, grid, applied } — the op landed (or replayed, or no-oped;
 *       `applied` is the content diff's verdict, and decides the broadcast).
 *   409 { rev, grid }          — stale `baseRev`; the body is the truth to
 *       rebase against, not an error to surrender to.
 *
 * Gated by the same session-access check the blob PUT uses, with the same
 * family policy: an unknown session and a denied session answer the SAME 404
 * (`sessionNotFoundOrDenied`) so a probe learns nothing from the difference.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { workspaceLayoutVerbSchema } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import { checkSessionAccess } from '@/lib/agent-workspaces/agent-sessions-runtime';
import { applyWorkspaceLayoutVerb } from '@/lib/agent-workspaces/workspace-layout-runtime';
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

  let result;
  try {
    result = await applyWorkspaceLayoutVerb({
      workspaceId: workspaceId,
      opId: parsed.data.opId,
      baseRev: parsed.data.baseRev,
      verb: parsed.data.verb,
    });
  } catch (error) {
    loggers.api.error('Workspace layout verb failed', error instanceof Error ? error : undefined, { workspaceId });
    return NextResponse.json({ error: 'Could not apply the layout verb' }, { status: 502 });
  }

  if (result.status === 'stale') {
    return NextResponse.json({ rev: result.rev, grid: result.grid }, { status: 409 });
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

  return NextResponse.json({ rev: result.rev, grid: result.grid, applied: result.applied });
}
