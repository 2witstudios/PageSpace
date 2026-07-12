import { create } from 'zustand';
import type { PendingSession } from '@/lib/development/pending-session';
import type { OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';

/**
 * The one session-open intent in flight from the Development sidebar.
 *
 * The sidebar and the machine's pane region are siblings in the layout (the
 * sidebar lives above the routed page), so the click and the component that can
 * honour it have no common parent to hold this — hence a store, in the same way
 * the machine workspace itself is shared by composition.
 *
 * Single-slot on purpose: a second click supersedes the first, because the user
 * only ever ends up on one machine. All the decision-making lives in the pure
 * `resolvePendingSession`; this only holds the value.
 */
interface PendingSessionStoreState {
  pending: PendingSession | null;
  requestSession: (machineId: string, scope: OpenTerminalScope) => void;
  clearPending: () => void;
}

export const usePendingSessionStore = create<PendingSessionStoreState>((set) => ({
  pending: null,
  requestSession: (machineId, scope) => set({ pending: { machineId, scope } }),
  clearPending: () => set((state) => (state.pending === null ? state : { pending: null })),
}));
