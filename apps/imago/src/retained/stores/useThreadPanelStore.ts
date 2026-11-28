/**
 * Thread Panel Store
 *
 * Tracks the open/closed state of the right-side ThreadPanel that overlays
 * channel and DM message lists. The panel is generic across both surfaces;
 * `source` + `contextId` discriminate which channel/DM the open thread
 * belongs to so the mounting page can render the panel only when the
 * context still matches the route.
 *
 * Stores are pure: navigation cleanup (close-on-context-change) is performed
 * by the mounting page via `useEffect`, not from inside the store.
 */

import { create } from 'zustand';

export type ThreadPanelSource = 'channel' | 'dm';

export interface OpenThreadArgs {
  source: ThreadPanelSource;
  contextId: string;
  parentId: string;
}

export interface ThreadPanelState {
  open: boolean;
  source: ThreadPanelSource | null;
  contextId: string | null;
  parentId: string | null;
  openThread: (args: OpenThreadArgs) => void;
  close: () => void;
}

export const useThreadPanelStore = create<ThreadPanelState>((set) => ({
  open: false,
  source: null,
  contextId: null,
  parentId: null,
  openThread: ({ source, contextId, parentId }) =>
    set({ open: true, source, contextId, parentId }),
  close: () => set({ open: false, source: null, contextId: null, parentId: null }),
}));
