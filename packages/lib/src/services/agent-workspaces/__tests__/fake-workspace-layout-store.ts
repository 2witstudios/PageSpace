import type { LayoutGridColumn } from '../../../agent-workspaces/workspace-layout-verbs';
import type { WorkspaceLayoutOpRecord, WorkspaceLayoutStore } from '../workspace-layout-store';

function gridsEqual(a: LayoutGridColumn[], b: LayoutGridColumn[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** In-memory fake mirroring the DB-backed store's transactional semantics —
 * see workspace-layout-store.ts's module doc. */
export function createFakeWorkspaceLayoutStore(): WorkspaceLayoutStore {
  const grids = new Map<string, LayoutGridColumn[]>();
  const revs = new Map<string, number>();
  const ops = new Map<string, WorkspaceLayoutOpRecord>();

  const opKey = (workspaceId: string, opId: string) => `${workspaceId}::${opId}`;

  return {
    // Every boundary crossing (read or write) clones — a real DB round-trip
    // never hands back the caller's own references, so a caller mutating what
    // it got or gave must not corrupt this fake's storage, matching the real
    // store's isolation semantics.
    async getWorkspaceGrid(workspaceId) {
      return structuredClone(grids.get(workspaceId) ?? []);
    },

    async getWorkspaceGridsBulk(workspaceIds) {
      const out = new Map<string, LayoutGridColumn[]>();
      for (const workspaceId of workspaceIds) {
        const grid = grids.get(workspaceId);
        if (grid && grid.length > 0) out.set(workspaceId, structuredClone(grid));
      }
      return out;
    },

    async replaceWorkspaceGrid({ workspaceId, grid }) {
      const current = grids.get(workspaceId) ?? [];
      if (gridsEqual(current, grid)) {
        return { rev: revs.get(workspaceId) ?? 0, applied: false };
      }
      grids.set(workspaceId, structuredClone(grid));
      const next = (revs.get(workspaceId) ?? 0) + 1;
      revs.set(workspaceId, next);
      return { rev: next, applied: true };
    },

    async currentRev(workspaceId) {
      return revs.get(workspaceId) ?? 0;
    },

    async findOp(workspaceId, opId) {
      const op = ops.get(opKey(workspaceId, opId));
      return op ? { ...op } : null;
    },

    async recordOp({ workspaceId, opId, rev, applied }) {
      const key = opKey(workspaceId, opId);
      if (!ops.has(key)) ops.set(key, { rev, applied });
    },
  };
}
