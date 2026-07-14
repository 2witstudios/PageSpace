/**
 * Machine Workspaces bootstrap — one-time seeding of a machine's
 * `localStorage`-only workspace history into the shared server record (#2048).
 *
 * POST { machineId, workspaces: [{id, name, scope, columns}, ...] }
 *
 * Exactly ONE caller across every browser racing a machine's first load ever
 * gets `claimed: true` — see `machine_workspace_bootstraps` (schema doc) and
 * `bootstrapWorkspaces` (service doc) for why this needs a dedicated atomic
 * claim rather than per-row upsert alone. Every other caller (whether it lost
 * the race or the machine was already bootstrapped) gets `claimed: false`
 * back with the CURRENT canonical list — same response shape either way, so
 * the client always has something to adopt.
 */

import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { bootstrapWorkspaces, type BootstrapWorkspaceInput } from '@pagespace/lib/services/machines/machine-workspaces';
import {
  buildMachineWorkspacesDeps,
  canAccessMachine,
  forbiddenMachineAccess,
  RESOURCE_TYPE,
  scopeFromBody,
  toWorkspaceDTO,
  WORKSPACE_DENIAL_STATUS,
} from '@/lib/machines/machine-workspaces-runtime';
import { broadcastMachineWorkspaceEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function parseWorkspaces(value: unknown): BootstrapWorkspaceInput[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: BootstrapWorkspaceInput[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = entry as { id?: unknown; name?: unknown; scope?: unknown; columns?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
    if (typeof candidate.name !== 'string') return null;
    parsed.push({ id: candidate.id, name: candidate.name, scope: scopeFromBody(candidate.scope), layout: { columns: candidate.columns } });
  }
  return parsed;
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; workspaces?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
    return NextResponse.json({ error: 'machineId is required' }, { status: 400 });
  }
  const workspaces = parseWorkspaces(body.workspaces);
  if (!workspaces) {
    return NextResponse.json({ error: 'workspaces must be an array of {id, name, scope, columns}' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, body.machineId))) {
    return forbiddenMachineAccess(request, auth.userId, body.machineId);
  }

  const deps = buildMachineWorkspacesDeps();
  const result = await bootstrapWorkspaces({
    machineId: body.machineId,
    ownerId: auth.userId,
    userId: auth.userId,
    workspaces,
    deps,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason, reason: result.reason }, { status: WORKSPACE_DENIAL_STATUS[result.reason] ?? 500 });
  }

  if (result.claimed) {
    void broadcastMachineWorkspaceEvent(body.machineId, 'machine-workspace:bootstrapped', {
      machineId: body.machineId,
      workspaces: result.workspaces.map(toWorkspaceDTO),
    });
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: body.machineId,
      details: { action: 'workspaces_bootstrapped', workspaceCount: result.workspaces.length },
      riskScore: 0,
    });
  }

  return NextResponse.json({ claimed: result.claimed, workspaces: result.workspaces.map(toWorkspaceDTO) });
}
