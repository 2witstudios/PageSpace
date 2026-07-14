import { create } from 'zustand';
import type { PendingWorkspace } from '@/lib/development/pending-workspace';

/**
 * The one workspace-select intent in flight from the Development sidebar.
 *
 * The sidebar and the machine's pane region are siblings in the layout (the
 * sidebar lives above the routed page), so the click and the component that can
 * honour it have no common parent to hold this — hence a store, in the same way
 * the machine workspace itself is shared by composition.
 *
 * Single-slot on purpose: a second click supersedes the first, because the user
 * only ever ends up on one machine. All the decision-making lives in the pure
 * `resolvePendingWorkspace`; this only holds the value.
 */
interface PendingWorkspaceStoreState {
  pending: PendingWorkspace | null;
  requestWorkspace: (machineId: string, workspaceId: string) => void;
  clearPending: () => void;
}

export const usePendingWorkspaceStore = create<PendingWorkspaceStoreState>((set) => ({
  pending: null,
  requestWorkspace: (machineId, workspaceId) => set({ pending: { machineId, workspaceId } }),
  // Identity-stable when there's nothing to clear, so a no-op clear can't
  // re-render (and so the drain effect can call it unconditionally).
  clearPending: () => set((state) => (state.pending === null ? state : { pending: null })),
}));
