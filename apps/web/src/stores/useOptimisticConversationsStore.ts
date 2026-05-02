import { create } from 'zustand';

export interface OptimisticConversationEntry {
  id: string;
  title: string;
  createdAt: string;
}

interface OptimisticConversationsState {
  /**
   * Optimistic conversation entries received from chat:conversation_added
   * broadcasts, keyed by the SWR cache URL of the owning conversation list.
   * Survives the moment where the list hook is disabled (history tab not yet
   * mounted) and the moment where SWR refetches without the lazily-materialized
   * row. Entries are pruned by `prune()` once the server-confirmed conversation
   * list includes them.
   */
  byKey: Record<string, OptimisticConversationEntry[]>;
  add: (cacheKey: string, entry: OptimisticConversationEntry) => void;
  prune: (cacheKey: string, knownIds: string[]) => void;
}

export const useOptimisticConversationsStore = create<OptimisticConversationsState>((set) => ({
  byKey: {},
  add: (cacheKey, entry) =>
    set((state) => {
      const existing = state.byKey[cacheKey] ?? [];
      if (existing.some((e) => e.id === entry.id)) return state;
      return {
        byKey: { ...state.byKey, [cacheKey]: [entry, ...existing] },
      };
    }),
  prune: (cacheKey, knownIds) =>
    set((state) => {
      const existing = state.byKey[cacheKey];
      if (!existing || existing.length === 0) return state;
      const known = new Set(knownIds);
      const filtered = existing.filter((e) => !known.has(e.id));
      if (filtered.length === existing.length) return state;
      return {
        byKey: { ...state.byKey, [cacheKey]: filtered },
      };
    }),
}));
