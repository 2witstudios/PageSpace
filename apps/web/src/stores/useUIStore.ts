import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SelectionMode = 'single' | 'toggle' | 'range';

export interface UIState {
  // Sidebar state
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;

  // Tree state
  treeExpanded: Set<string>;
  treeScrollPosition: number;

  // Selection state for multi-select in sidebar
  selectedPageIds: Set<string>;
  lastSelectedPageId: string | null;

  // Current view type
  centerViewType: 'document' | 'folder' | 'channel' | 'ai' | 'settings';

  // Loading states
  isNavigating: boolean;

  // Actions
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebar: (open: boolean) => void;
  setRightSidebar: (open: boolean) => void;
  setCenterViewType: (viewType: UIState['centerViewType']) => void;
  setNavigating: (navigating: boolean) => void;
  setTreeExpanded: (nodeId: string, expanded: boolean) => void;
  setTreeScrollPosition: (position: number) => void;

  // Selection actions
  selectPage: (id: string, mode: SelectionMode, flattenedIds?: string[]) => void;
  clearSelection: () => void;
  setSelection: (ids: string[]) => void;
  isPageSelected: (id: string) => boolean;
  getSelectedPageIds: () => string[];
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      leftSidebarOpen: true,
      rightSidebarOpen: true,
      treeExpanded: new Set(),
      treeScrollPosition: 0,
      selectedPageIds: new Set(),
      lastSelectedPageId: null,
      centerViewType: 'document',
      isNavigating: false,

      // Actions
      toggleLeftSidebar: () => {
        set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen }));
      },

      toggleRightSidebar: () => {
        set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen }));
      },

      setLeftSidebar: (open: boolean) => {
        set({ leftSidebarOpen: open });
      },

      setRightSidebar: (open: boolean) => {
        set({ rightSidebarOpen: open });
      },

      setCenterViewType: (viewType: UIState['centerViewType']) => {
        set({ centerViewType: viewType });
      },

      setNavigating: (navigating: boolean) => {
        set({ isNavigating: navigating });
      },

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

      // Selection actions
      selectPage: (id: string, mode: SelectionMode, flattenedIds?: string[]) => {
        const state = get();
        const newSelected = new Set(state.selectedPageIds);

        switch (mode) {
          case 'single':
            // Clear and select only this item
            newSelected.clear();
            newSelected.add(id);
            set({ selectedPageIds: newSelected, lastSelectedPageId: id });
            break;

          case 'toggle':
            // Toggle this item in selection (Ctrl/Cmd+click)
            if (newSelected.has(id)) {
              newSelected.delete(id);
            } else {
              newSelected.add(id);
            }
            set({ selectedPageIds: newSelected, lastSelectedPageId: id });
            break;

          case 'range':
            // Select range from lastSelectedPageId to id (Shift+click)
            if (flattenedIds && state.lastSelectedPageId) {
              const startIdx = flattenedIds.indexOf(state.lastSelectedPageId);
              const endIdx = flattenedIds.indexOf(id);
              if (startIdx !== -1 && endIdx !== -1) {
                const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                for (let i = from; i <= to; i++) {
                  newSelected.add(flattenedIds[i]);
                }
              }
            } else {
              // No previous selection, just select this one
              newSelected.add(id);
            }
            set({ selectedPageIds: newSelected, lastSelectedPageId: id });
            break;
        }
      },

      clearSelection: () => {
        set({ selectedPageIds: new Set(), lastSelectedPageId: null });
      },

      setSelection: (ids: string[]) => {
        set({
          selectedPageIds: new Set(ids),
          lastSelectedPageId: ids.length > 0 ? ids[ids.length - 1] : null,
        });
      },

      isPageSelected: (id: string) => {
        return get().selectedPageIds.has(id);
      },

      getSelectedPageIds: () => {
        return Array.from(get().selectedPageIds);
      },
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        rightSidebarOpen: state.rightSidebarOpen,
        treeExpanded: Array.from(state.treeExpanded), // Serialize Set to Array
        treeScrollPosition: state.treeScrollPosition,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.treeExpanded) {
          // Convert Array back to Set on rehydration
          const expanded = state.treeExpanded;
          state.treeExpanded = new Set(Array.isArray(expanded) ? expanded : Array.from(expanded as Set<string>));
        }
        // Initialize selection state (not persisted)
        if (state) {
          state.selectedPageIds = new Set();
          state.lastSelectedPageId = null;
        }
      },
    }
  )
);