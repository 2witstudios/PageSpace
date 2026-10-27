import { create } from 'zustand';

/**
 * One-shot requests from chrome OUTSIDE the pane grid (the session head's "Add pane") to
 * the grid that owns the workspace tree. Each is a monotonically increasing counter per
 * session: the grid reacts to a change, so a request made while nothing is mounted is
 * dropped rather than replayed later.
 */
interface PaneRequestState {
  readonly addPane: Readonly<Record<string, number>>;
  requestAddPane(sessionId: string): void;
}

export const useAgentPaneRequestStore = create<PaneRequestState>((set) => ({
  addPane: {},
  requestAddPane: (sessionId) =>
    set((state) => ({ addPane: { ...state.addPane, [sessionId]: (state.addPane[sessionId] ?? 0) + 1 } })),
}));
