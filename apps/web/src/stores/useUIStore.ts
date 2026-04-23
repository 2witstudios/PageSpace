import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UIState {
  // Tree state (PERSISTED)
  treeExpanded: Set<string>;
  treeScrollPosition: number;

  // Quick-create palette state (NOT persisted)
  quickCreateOpen: boolean;
  quickCreateParentOverride: string | null | undefined;

  // Actions
  setTreeExpanded: (nodeId: string, expanded: boolean) => void;
  setTreeScrollPosition: (position: number) => void;
  openQuickCreate: (parentOverride?: string | null) => void;
  closeQuickCreate: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      treeExpanded: new Set(),
      treeScrollPosition: 0,
      quickCreateOpen: false,
      quickCreateParentOverride: undefined,

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

      openQuickCreate: (parentOverride?: string | null) => {
        set({ quickCreateOpen: true, quickCreateParentOverride: parentOverride });
      },

      closeQuickCreate: () => {
        set({ quickCreateOpen: false, quickCreateParentOverride: undefined });
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
