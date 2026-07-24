import type { MachinePanesStore, WorkspaceGridColumnInput, WorkspaceGridColumnRecord } from '../machine-panes-store';

function rowKey(machineId: string, workspaceId: string): string {
  return `${machineId}::${workspaceId}`;
}

function gridsEqual(a: WorkspaceGridColumnInput[], b: WorkspaceGridColumnInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** In-memory fake mirroring the DB-backed store's transactional semantics — see machine-panes-store.ts's module doc. */
export function createFakeMachinePanesStore(): MachinePanesStore {
  const grids = new Map<string, WorkspaceGridColumnRecord[]>();
  const revs = new Map<string, number>();

  const bump = (machineId: string): number => {
    const next = (revs.get(machineId) ?? 0) + 1;
    revs.set(machineId, next);
    return next;
  };

  return {
    // Every boundary crossing (read or write) clones — a real DB round-trip
    // never hands back the caller's own array/object references, so a caller
    // mutating what it got from `getWorkspaceGrid` or what it passed into
    // `replaceWorkspaceGrid` must not be able to corrupt this fake's storage
    // (or vice versa), matching the real store's isolation semantics.
    async getWorkspaceGrid(machineId, workspaceId) {
      return structuredClone(grids.get(rowKey(machineId, workspaceId)) ?? []);
    },

    async getMachineGrids(machineId) {
      const result = new Map<string, WorkspaceGridColumnRecord[]>();
      for (const [key, grid] of grids) {
        const [rowMachineId, workspaceId] = key.split('::');
        if (rowMachineId === machineId) result.set(workspaceId, structuredClone(grid));
      }
      return result;
    },

    async replaceWorkspaceGrid({ machineId, workspaceId, grid }) {
      const key = rowKey(machineId, workspaceId);
      const current = grids.get(key) ?? [];
      if (gridsEqual(current, grid)) {
        return { rev: revs.get(machineId) ?? 0, applied: false };
      }
      grids.set(key, structuredClone(grid));
      return { rev: bump(machineId), applied: true };
    },

    async bumpRev(machineId) {
      return bump(machineId);
    },

    async currentRev(machineId) {
      return revs.get(machineId) ?? 0;
    },
  };
}
