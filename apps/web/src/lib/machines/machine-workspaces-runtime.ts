/**
 * Production wiring for Machine Workspaces (the sidebar's named pane-grid
 * workspaces — server-authoritative sync, see #2048).
 *
 * Pure metadata CRUD, unlike the sandbox/git-backed Projects/Branches
 * runtimes — `buildMachineWorkspacesDeps` only needs a store and a clock.
 * Reuses the canonical shared access check (`./machine-access-runtime`)
 * rather than re-deriving `canViewMachine`/`canAccessMachine` inline, per
 * that module's own doc comment for new routes.
 */

import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canViewMachine, canEditMachine as canAccessMachine } from './machine-access-runtime';
import { deriveWorkspaceScope } from '@pagespace/lib/services/machines/machine-workspaces';
import { createDbMachineWorkspaceStore } from '@pagespace/lib/services/machines/machine-workspaces-store';
import type { MachineWorkspaceRecord } from '@pagespace/lib/services/machines/machine-workspaces-store';
import type { MachineWorkspacesDeps } from '@pagespace/lib/services/machines/machine-workspaces';

export { canViewMachine, canAccessMachine };

/** Shared by every machine-workspaces route (`route.ts`, `bootstrap/route.ts`)
 * for both the `auditRequest` resource type and denial-reason status mapping
 * below — kept here, not duplicated per-file, so the two routes can't
 * silently drift on what they audit or which denial reason maps to which
 * HTTP status. */
export const RESOURCE_TYPE = 'machine';

/** Status code for each denial reason `createWorkspace`/`updateWorkspace`/
 * `bootstrapWorkspaces` can return (see machine-workspaces.ts's `WorkspacePlanDenialReason`). */
export const WORKSPACE_DENIAL_STATUS: Record<string, number> = {
  invalid_name: 400,
  invalid_columns: 400,
  not_found: 404,
};

/** Parses the wire `{projectName?, branchName?}` scope shape from a POST/bootstrap
 * body, dropping empty-string fields so `deriveWorkspaceScope` sees them as absent. */
export function scopeFromBody(value: unknown): { projectName?: string; branchName?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as { projectName?: unknown; branchName?: unknown };
  return {
    ...(typeof candidate.projectName === 'string' && candidate.projectName.length > 0
      ? { projectName: candidate.projectName }
      : {}),
    ...(typeof candidate.branchName === 'string' && candidate.branchName.length > 0
      ? { branchName: candidate.branchName }
      : {}),
  };
}

/** Audits the authz denial (so SIEM can detect probing) and returns a fresh 403. */
export function forbiddenMachineAccess(request: Request, userId: string, machineId: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: RESOURCE_TYPE,
    resourceId: machineId,
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
}

/**
 * The node a workspace hangs under, on the wire — the client's
 * `MachineNodeScope` discriminated union, byte-shaped.
 *
 * The discriminant is DERIVED here, by `deriveWorkspaceScope`, which stays the
 * single adapter between "which name columns are set" and "which node kind
 * this is" (the `scope` text column is populated by the same function on
 * write). Deriving rather than reading the stored column keeps the two from
 * ever disagreeing on the wire, and means a row written before the column
 * existed still serialises correctly.
 */
export type WorkspaceScopeDTO =
  | { level: 'machine' }
  | { level: 'project'; projectName: string }
  | { level: 'branch'; projectName: string; branchName: string };

export function toWorkspaceScopeDTO(record: {
  projectName: string | null;
  branchName: string | null;
}): WorkspaceScopeDTO {
  const names = {
    ...(record.projectName ? { projectName: record.projectName } : {}),
    ...(record.branchName ? { branchName: record.branchName } : {}),
  };
  switch (deriveWorkspaceScope(names)) {
    case 'machine':
      return { level: 'machine' };
    case 'project':
      // `deriveWorkspaceScope` answers 'project'/'branch' only when the
      // corresponding name is set, so these non-null assertions are its
      // postcondition rather than an assumption about the row.
      return { level: 'project', projectName: names.projectName! };
    case 'branch':
      return { level: 'branch', projectName: names.projectName!, branchName: names.branchName! };
  }
}

/** The wire shape returned to clients — a `MachineWorkspaceRecord` with its
 * scope columns folded back into the discriminated node shape the client's
 * `MachineNodeScope` uses, and `layout.columns` hoisted to a bare `columns`
 * field (the client's `WorkspaceState` has no `layout` wrapper — that's a
 * server/DB-only nesting detail). */
export interface WorkspaceDTO {
  id: string;
  name: string;
  scope: WorkspaceScopeDTO;
  columns: MachineWorkspaceRecord['layout']['columns'];
  createdAt: string;
  updatedAt: string;
}

export function toWorkspaceDTO(record: MachineWorkspaceRecord): WorkspaceDTO {
  return {
    id: record.id,
    name: record.name,
    scope: toWorkspaceScopeDTO(record),
    columns: record.layout.columns,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

let storePromise: ReturnType<typeof createDbMachineWorkspaceStore> | null = null;
function getStore() {
  storePromise ??= createDbMachineWorkspaceStore();
  return storePromise;
}

export function buildMachineWorkspacesDeps(): MachineWorkspacesDeps {
  return {
    store: {
      list: async (machineId) => (await getStore()).list(machineId),
      findById: async (machineId, id) => (await getStore()).findById(machineId, id),
      insertIfAbsent: async (input) => (await getStore()).insertIfAbsent(input),
      update: async (machineId, id, patch, now) => (await getStore()).update(machineId, id, patch, now),
      remove: async (machineId, id) => (await getStore()).remove(machineId, id),
    },
    now: () => new Date(),
  };
}
