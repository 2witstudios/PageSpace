import { create } from 'zustand';

/**
 * One-shot requests from chrome OUTSIDE the pane grid (the session toolbar's "Add pane")
 * or from a pane head ("Open shell") to the grid that owns the workspace tree. Each is a
 * monotonically increasing counter per session: the grid reacts to a change, so a request
 * made while nothing is mounted is dropped by `consume` rather than replayed later.
 */
interface PaneRequestState {
  readonly addPane: Readonly<Record<string, number>>;
  readonly openShell: Readonly<Record<string, number>>;
  requestAddPane(sessionId: string): void;
  requestOpenShell(sessionId: string): void;
}

export const useAgentPaneRequestStore = create<PaneRequestState>((set) => ({
  addPane: {},
  openShell: {},
  requestAddPane: (sessionId) =>
    set((state) => ({ addPane: { ...state.addPane, [sessionId]: (state.addPane[sessionId] ?? 0) + 1 } })),
  requestOpenShell: (sessionId) =>
    set((state) => ({ openShell: { ...state.openShell, [sessionId]: (state.openShell[sessionId] ?? 0) + 1 } })),
}));
