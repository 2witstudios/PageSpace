import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UIState {
  // Sidebar state
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  
  // Tree state
  treeExpanded: Set<string>;
  treeScrollPosition: number;
  
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
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      leftSidebarOpen: true,
      rightSidebarOpen: true,
      treeExpanded: new Set(),
      treeScrollPosition: 0,
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
      },
    }
  )
);