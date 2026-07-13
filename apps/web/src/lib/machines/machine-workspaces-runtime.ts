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

import { canViewMachine, canEditMachine as canAccessMachine } from './machine-access-runtime';
import { createDbMachineWorkspaceStore } from '@pagespace/lib/services/machines/machine-workspaces-store';
import type { MachineWorkspaceRecord } from '@pagespace/lib/services/machines/machine-workspaces-store';
import type { MachineWorkspacesDeps } from '@pagespace/lib/services/machines/machine-workspaces';

export { canViewMachine, canAccessMachine };

/** The wire shape returned to clients — a `MachineWorkspaceRecord` with its
 * scope columns folded back into the nested `{projectName?, branchName?}`
 * shape the client's `MachineNodeScope` uses, and `layout.columns` hoisted
 * to a bare `columns` field (the client's `WorkspaceState` has no `layout`
 * wrapper — that's a server/DB-only nesting detail). */
export interface WorkspaceDTO {
  id: string;
  name: string;
  scope: { projectName?: string; branchName?: string };
  columns: MachineWorkspaceRecord['layout']['columns'];
  createdAt: string;
  updatedAt: string;
}

export function toWorkspaceDTO(record: MachineWorkspaceRecord): WorkspaceDTO {
  return {
    id: record.id,
    name: record.name,
    scope: {
      ...(record.projectName ? { projectName: record.projectName } : {}),
      ...(record.branchName ? { branchName: record.branchName } : {}),
    },
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
      isBootstrapped: async (machineId) => (await getStore()).isBootstrapped(machineId),
      bootstrapSeed: async (input) => (await getStore()).bootstrapSeed(input),
    },
    now: () => new Date(),
  };
}
