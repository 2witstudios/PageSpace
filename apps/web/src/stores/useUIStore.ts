import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UIState {
  // Tree state (PERSISTED)
  treeExpanded: Set<string>;
  treeScrollPosition: number;

  // Actions
  setTreeExpanded: (nodeId: string, expanded: boolean) => void;
  setTreeScrollPosition: (position: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      treeExpanded: new Set(),
      treeScrollPosition: 0,

      // Actions
      setTreeExpanded: (nodeId: string, expanded: boolean) => {
        const newExpanded = new Set(get().treeExpanded);
        if (expanded) {
          newExpanded.add(nodeId);
        } else {
          newExpanded.delete(nodeId);
        }
        set({ treeExpanded: newExpanded });
      },

      setTreeScrollPosition: (position: number) => {
        set({ treeScrollPosition: position });
      },
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        treeExpanded: Array.from(state.treeExpanded),
        treeScrollPosition: state.treeScrollPosition,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.treeExpanded) {
          const expanded = state.treeExpanded;
          state.treeExpanded = new Set(Array.isArray(expanded) ? expanded : Array.from(expanded as Set<string>));
        }
      },
    }
  )
);
