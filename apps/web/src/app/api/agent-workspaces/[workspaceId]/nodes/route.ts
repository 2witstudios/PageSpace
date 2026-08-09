/**
 * The workspace NODE model's endpoint — one read and one write.
 *
 *   GET  → 200 { rev, nodes, targets }   the whole truth for one workspace
 *   POST { baseRev, put, drop }
 *        → 200 { rev, nodes, targets }   the write landed (or was a no-op)
 *        → 409 { rev, nodes, targets }   stale `baseRev`; the body is the truth
 *                                        to rebase against, not an error
 *        → 409 { rev, nodes, targets,    a conversation the write would show is
 *                code, detail }          already shown by a node elsewhere; the
 *                                        same truth, plus which rule refused
 *        → 400 { error, code, detail }   the payload names another workspace, or
 *                                        the tree it would produce is invalid
 *        → 403 { error }                 you may use this workspace, but not
 *                                        show that target in it
 *
 * **There is no `opId`, and there is no idempotency table behind this.** The
 * write primitive is an UPSERT of a node set (`upsertNodes` — replace by id
 * where present, append where not), so a retried POST re-applies to the same
 * state by construction. `agent_workspace_layout_ops` existed because a
 * replayed `split_right` re-inserted its own client-minted pane id and violated
 * the primary key; nothing here can. A replay lands on the same tree, finds
 * nothing changed, mints no rev and broadcasts nothing.
 *
 * **The 409 body is the same shape as the 200 body, deliberately.** A stale
 * caller needs exactly what a fresh reader needs and must not be told more than
 * a GET would tell it, so both go through the same per-viewer target
 * resolution.
 *
 * **Two gates, and the second is not optional.** Reaching a workspace is
 * `checkSessionAccess`, with the same family policy every session route uses:
 * an unknown workspace and a denied one answer the same 404, so a probe learns
 * nothing from the difference. Reaching a workspace says NOTHING about the
 * `target.id`s a node points at — those are free-form in the body — so a second
 * gate settles every binding the write INTRODUCES before anything is persisted
 * (security review HIGH 1, attack B). It runs inside the write's lock, against
 * the tree that lock read; see `introducedPaneTargets`.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { workspaceNodeWriteRequestSchema } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import type {
  WorkspaceNodeConflictResponse,
  WorkspaceNodeSnapshotResponse,
} from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { checkSessionAccess } from '@/lib/agent-workspaces/agent-workspaces-runtime';
import { applyWorkspaceNodeWrite, readWorkspaceNodes } from '@/lib/agent-workspaces/workspace-node-runtime';
import { workspaceNotFoundOrDenied } from '@/lib/agent-workspaces/workspace-unavailable-response';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const ROUTE = 'agent-workspaces/[workspaceId]/nodes';

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  try {
    const snapshot: WorkspaceNodeSnapshotResponse = await readWorkspaceNodes(workspaceId, auth.userId);
    return NextResponse.json(snapshot);
  } catch (error) {
    loggers.api.error('Workspace node read failed', error instanceof Error ? error : undefined, { workspaceId });
    return NextResponse.json({ error: 'Could not read the workspace layout' }, { status: 502 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const { workspaceId } = await context.params;

  const access = await checkSessionAccess(auth.userId, workspaceId);
  if (!access.allowed) {
    return workspaceNotFoundOrDenied(request, auth.userId, workspaceId, access.reason, ROUTE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'baseRev, put, and drop are required' }, { status: 400 });
  }

  const parsed = workspaceNodeWriteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid node payload', issues: parsed.error.issues }, { status: 400 });
  }

  let result;
  try {
    result = await applyWorkspaceNodeWrite({
      workspaceId,
      baseRev: parsed.data.baseRev,
      put: parsed.data.put,
      drop: parsed.data.drop,
      viewerId: auth.userId,
    });
  } catch (error) {
    loggers.api.error('Workspace node write failed', error instanceof Error ? error : undefined, { workspaceId });
    return NextResponse.json({ error: 'Could not apply the layout write' }, { status: 502 });
  }

  if (result.status === 'refused') {
    // A target the caller may not bind is 403 and says nothing about which one —
    // uniform across "forbidden" and "no such target", so a caller probing ids
    // learns nothing. Everything else is a 400 carrying the validator's own
    // machine-readable code, because a client that sent an impossible tree has
    // to know WHICH invariant it broke to have any chance of correcting it.
    if (result.code === 'forbidden_target') {
      return NextResponse.json({ error: result.detail }, { status: 403 });
    }
    return NextResponse.json(
      { error: 'That write would not leave a valid workspace', code: result.code, detail: result.detail },
      { status: 400 },
    );
  }

  if (result.status === 'stale') {
    return NextResponse.json(result.snapshot, { status: 409 });
  }

  // The OTHER 409, and 409 for the same reason: the caller's edit does not
  // apply and it needs the tree to rebase onto, not an error string. A
  // conversation is bound to at most one node ACROSS THE WHOLE TABLE
  // (`UNIQUE (targetId) WHERE targetKind = 'chat'` carries no `rootId`), so a
  // node in a workspace this caller may not even know exists can be holding the
  // one they asked for. That is a domain refusal, and answering it as a 502 —
  // which is what a raw index violation reaching the catch above produces —
  // tells an optimistically-applied client nothing, leaving its phantom pane on
  // screen until an unrelated poll corrects it.
  //
  // The body is the snapshot PLUS the code, so the existing rebase path fires
  // unchanged and a client that wants to explain itself can.
  if (result.status === 'conflict') {
    const body: WorkspaceNodeConflictResponse = {
      ...result.snapshot,
      code: result.code,
      detail: result.detail,
    };
    return NextResponse.json(body, { status: 409 });
  }

  if (result.changed) {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'agent_session',
      resourceId: workspaceId,
      details: {
        op: 'workspace_nodes_write',
        put: parsed.data.put.length,
        drop: parsed.data.drop.length,
        rev: result.snapshot.rev,
      },
    });
  }

  return NextResponse.json(result.snapshot);
}
