import type { PersistedWorkspaceState } from '../../../agent-sessions/contract';
import type { LayoutGridColumn } from '../../../agent-sessions/workspace-layout-verbs';
import type { WorkspaceLayoutOpRecord, WorkspaceLayoutStore } from '../workspace-layout-store';

function gridsEqual(a: LayoutGridColumn[], b: LayoutGridColumn[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** In-memory fake mirroring the DB-backed store's transactional semantics —
 * see workspace-layout-store.ts's module doc. Exposes `blobs` so tests can
 * assert the dual-write leg (rows and blob committing together). */
export function createFakeWorkspaceLayoutStore(): WorkspaceLayoutStore & {
  blobs: Map<string, PersistedWorkspaceState>;
} {
  const grids = new Map<string, LayoutGridColumn[]>();
  const revs = new Map<string, number>();
  const blobs = new Map<string, PersistedWorkspaceState>();
  const ops = new Map<string, WorkspaceLayoutOpRecord>();

  const opKey = (workspaceId: string, opId: string) => `${workspaceId}::${opId}`;

  return {
    blobs,

    // Every boundary crossing (read or write) clones — a real DB round-trip
    // never hands back the caller's own references, so a caller mutating what
    // it got or gave must not corrupt this fake's storage, matching the real
    // store's isolation semantics.
    async getWorkspaceGrid(workspaceId) {
      return structuredClone(grids.get(workspaceId) ?? []);
    },

    async getWorkspaceBlob(workspaceId) {
      const blob = blobs.get(workspaceId);
      return blob ? structuredClone(blob) : null;
    },

    async replaceWorkspaceGrid({ workspaceId, grid, workspaceState }) {
      const current = grids.get(workspaceId) ?? [];
      if (gridsEqual(current, grid)) {
        return { rev: revs.get(workspaceId) ?? 0, applied: false };
      }
      grids.set(workspaceId, structuredClone(grid));
      if (workspaceState) blobs.set(workspaceId, structuredClone(workspaceState));
      const next = (revs.get(workspaceId) ?? 0) + 1;
      revs.set(workspaceId, next);
      return { rev: next, applied: true };
    },

    async saveWorkspaceBlob(workspaceId, workspaceState) {
      blobs.set(workspaceId, structuredClone(workspaceState));
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
