/**
 * Machine Workspaces API — the server-authoritative record of a Machine's
 * named pane-grid workspaces (#2048). Every browser/user viewing a Machine
 * sees the same workspace list; changes broadcast live over `apps/realtime`'s
 * room for the Machine's own page id.
 *
 * GET    ?machineId=                                          → list + bootstrap status
 * POST   { machineId, id, name, scope, columns }               → create (idempotent upsert-by-id)
 * PATCH  { machineId, workspaceId, name?, columns? }           → rename and/or layout update
 * DELETE ?machineId=&workspaceId=                              → remove
 *
 * Session-only (no MCP/agent tokens) — this is a human/UI surface. Every
 * request re-checks access for the named Machine page (view-level for GET,
 * edit-level for POST/PATCH/DELETE).
 *
 * `id` on POST is CLIENT-MINTED (see workspace-reducer.ts's `sessionWorkspaceId`
 * and `crypto.randomUUID()` call sites) — `createWorkspace` is a first-writer-wins
 * upsert-by-id, not an error on collision, because two browsers racing to
 * materialize the SAME session-derived workspace is expected, not a bug.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  createWorkspace,
  updateWorkspace,
  removeWorkspace,
  listWorkspaces,
} from '@pagespace/lib/services/machines/machine-workspaces';
import {
  buildMachineWorkspacesDeps,
  canAccessMachine,
  canViewMachine,
  forbiddenMachineAccess,
  RESOURCE_TYPE,
  scopeFromBody,
  toWorkspaceDTO,
  WORKSPACE_DENIAL_STATUS,
} from '@/lib/machines/machine-workspaces-runtime';
import { broadcastMachineWorkspaceEvent } from '@/lib/websocket';
import { broadcastLegacyGridSync, getCurrentRev, syncRelationalGrid } from '@/lib/machines/workspace-verbs-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

type ParsedField<T> = { ok: true; value: T } | { ok: false; error: NextResponse };

function fieldRequired(field: string): NextResponse {
  return NextResponse.json({ error: `${field} is required` }, { status: 400 });
}

function requireId(value: unknown, field: string): ParsedField<string> {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: fieldRequired(field) };
  return { ok: true, value };
}

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireId(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;

  if (!(await canViewMachine(auth.userId, machineId.value))) return forbiddenMachineAccess(request, auth.userId, machineId.value);

  const deps = buildMachineWorkspacesDeps();
  const [workspaces, rev] = await Promise.all([
    listWorkspaces({ machineId: machineId.value, store: deps.store }),
    getCurrentRev(machineId.value),
  ]);
  // Vestigial: the server is now the sole source of truth (#2202) — no
  // client ever needs to seed it from localStorage again. Hardcoded `true`
  // so an old, not-yet-redeployed client never re-attempts the (deleted)
  // bootstrap POST.
  return NextResponse.json({ workspaces: workspaces.map(toWorkspaceDTO), bootstrapped: true, rev });
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; id?: unknown; name?: unknown; scope?: unknown; columns?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const machineId = requireId(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;
  const id = requireId(body.id, 'id');
  if (!id.ok) return id.error;
  if (typeof body.name !== 'string') return fieldRequired('name');

  if (!(await canAccessMachine(auth.userId, machineId.value))) return forbiddenMachineAccess(request, auth.userId, machineId.value);

  const deps = buildMachineWorkspacesDeps();
  const result = await createWorkspace({
    machineId: machineId.value,
    ownerId: auth.userId,
    id: id.value,
    name: body.name,
    scope: scopeFromBody(body.scope),
    layout: { columns: body.columns },
    deps,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason, reason: result.reason }, { status: WORKSPACE_DENIAL_STATUS[result.reason] ?? 500 });
  }

  if (result.created) {
    void broadcastMachineWorkspaceEvent(machineId.value, 'machine-workspace:created', {
      machineId: machineId.value,
      ...toWorkspaceDTO(result.workspace),
    });
    // Rolling-deploy shim — see workspace-verbs-runtime.ts's module doc: mirror
    // this legacy create into the relational rows so new clients (watching
    // rev/`machine-workspace:verb`) see it too.
    const { rev } = await syncRelationalGrid(machineId.value, id.value, result.workspace.layout.columns);
    broadcastLegacyGridSync(machineId.value, id.value, rev, { ...toWorkspaceDTO(result.workspace) });
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: machineId.value,
      details: { workspaceId: id.value, action: 'workspace_created' },
      riskScore: 0,
    });
  }

  return NextResponse.json(
    { workspace: toWorkspaceDTO(result.workspace), created: result.created },
    { status: result.created ? 201 : 200 },
  );
}

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: { machineId?: unknown; workspaceId?: unknown; name?: unknown; columns?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const machineId = requireId(body.machineId, 'machineId');
  if (!machineId.ok) return machineId.error;
  const workspaceId = requireId(body.workspaceId, 'workspaceId');
  if (!workspaceId.ok) return workspaceId.error;

  const hasName = typeof body.name === 'string';
  const hasColumns = body.columns !== undefined;
  if (!hasName && !hasColumns) {
    return NextResponse.json({ error: 'At least one of name or columns is required' }, { status: 400 });
  }

  if (!(await canAccessMachine(auth.userId, machineId.value))) return forbiddenMachineAccess(request, auth.userId, machineId.value);

  const deps = buildMachineWorkspacesDeps();
  const result = await updateWorkspace({
    machineId: machineId.value,
    workspaceId: workspaceId.value,
    name: hasName ? (body.name as string) : undefined,
    layout: hasColumns ? { columns: body.columns } : undefined,
    deps,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason, reason: result.reason }, { status: WORKSPACE_DENIAL_STATUS[result.reason] ?? 500 });
  }

  void broadcastMachineWorkspaceEvent(machineId.value, 'machine-workspace:updated', {
    machineId: machineId.value,
    workspaceId: workspaceId.value,
    ...(hasName ? { name: result.workspace.name } : {}),
    ...(hasColumns ? { columns: result.workspace.layout.columns } : {}),
  });
  // Rolling-deploy shim — see workspace-verbs-runtime.ts's module doc.
  const { rev } = await syncRelationalGrid(machineId.value, workspaceId.value, hasColumns ? result.workspace.layout.columns : null);
  broadcastLegacyGridSync(machineId.value, workspaceId.value, rev, { ...toWorkspaceDTO(result.workspace) });
  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: RESOURCE_TYPE,
    resourceId: machineId.value,
    details: { workspaceId: workspaceId.value, fields: [...(hasName ? ['name'] : []), ...(hasColumns ? ['columns'] : [])] },
    riskScore: 0,
  });

  return NextResponse.json({ workspace: toWorkspaceDTO(result.workspace) });
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const machineId = requireId(url.searchParams.get('machineId'), 'machineId');
  if (!machineId.ok) return machineId.error;
  const workspaceId = requireId(url.searchParams.get('workspaceId'), 'workspaceId');
  if (!workspaceId.ok) return workspaceId.error;

  if (!(await canAccessMachine(auth.userId, machineId.value))) return forbiddenMachineAccess(request, auth.userId, machineId.value);

  const deps = buildMachineWorkspacesDeps();
  const result = await removeWorkspace({ machineId: machineId.value, workspaceId: workspaceId.value, store: deps.store });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 404 });
  }

  void broadcastMachineWorkspaceEvent(machineId.value, 'machine-workspace:deleted', {
    machineId: machineId.value,
    workspaceId: workspaceId.value,
  });
  // Rolling-deploy shim — see workspace-verbs-runtime.ts's module doc. The
  // workspace row (and its pane rows, via FK cascade) is already gone; only
  // the rev needs to advance.
  const { rev } = await syncRelationalGrid(machineId.value, workspaceId.value, null);
  broadcastLegacyGridSync(machineId.value, workspaceId.value, rev, null);
  auditRequest(request, {
    eventType: 'data.delete',
    userId: auth.userId,
    resourceType: RESOURCE_TYPE,
    resourceId: machineId.value,
    details: { workspaceId: workspaceId.value },
    riskScore: 0.5,
  });

  return NextResponse.json({ success: true });
}
