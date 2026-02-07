'use client';

import { create } from 'zustand';
import type { PresenceViewer } from '@/lib/websocket';

interface PresenceState {
  // pageId → list of unique viewers (deduplicated by userId on server)
  pageViewers: Map<string, PresenceViewer[]>;

  // Update viewers for a page
  setPageViewers: (pageId: string, viewers: PresenceViewer[]) => void;

  // Get viewers for a specific page
  getPageViewers: (pageId: string) => PresenceViewer[];

  // Clear all presence data (e.g., on disconnect)
  clearAll: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  pageViewers: new Map(),

  setPageViewers: (pageId, viewers) => {
    set((state) => {
      const newMap = new Map(state.pageViewers);
      if (viewers.length === 0) {
        newMap.delete(pageId);
      } else {
        newMap.set(pageId, viewers);
      }
      return { pageViewers: newMap };
    });
  },

  getPageViewers: (pageId) => {
    return get().pageViewers.get(pageId) || [];
  },

  clearAll: () => {
    set({ pageViewers: new Map() });
  },
}));
