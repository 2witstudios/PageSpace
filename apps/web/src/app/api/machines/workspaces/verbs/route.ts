/**
 * Machine Workspace Verbs API (#2202: entity promotion).
 *
 * POST { machineId, verb: WorkspaceVerb } → one ordered, idempotent mutation
 * over a machine's relational workspace/pane rows. Successor to the blob
 * PUT/PATCH on `../route.ts` (kept there as a rolling-deploy shim) — see
 * `@/lib/machines/workspace-verbs-runtime.ts`'s module doc for the verb set
 * and idempotency model.
 *
 * Session-only, edit-level access (same as every other workspaces write).
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  applyWorkspaceVerbLocked,
  broadcastWorkspaceVerbResult,
  parseWorkspaceVerb,
} from '@/lib/machines/workspace-verbs-runtime';
import { canAccessMachine, forbiddenMachineAccess, RESOURCE_TYPE, WORKSPACE_DENIAL_STATUS } from '@/lib/machines/machine-workspaces-runtime';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; verb?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
    return NextResponse.json({ error: 'machineId is required' }, { status: 400 });
  }
  const machineId = body.machineId;

  const parsed = parseWorkspaceVerb(body.verb);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  if (!(await canAccessMachine(auth.userId, machineId))) return forbiddenMachineAccess(request, auth.userId, machineId);

  const result = await applyWorkspaceVerbLocked(machineId, parsed.verb, auth.userId);

  if (!result.ok) {
    return NextResponse.json({ error: result.reason, reason: result.reason }, { status: WORKSPACE_DENIAL_STATUS[result.reason] ?? 500 });
  }

  broadcastWorkspaceVerbResult(machineId, parsed.verb, result);

  if (result.applied) {
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: machineId,
      details: { workspaceId: result.workspaceId, verb: parsed.verb.type },
      riskScore: 0,
    });
  }

  return NextResponse.json({ rev: result.rev, workspaceId: result.workspaceId, workspace: result.workspace, applied: result.applied });
}
