import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type TaskListViewMode = 'table' | 'kanban';

interface LayoutState {
  // UI panels state (PERSISTED)
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  taskListViewMode: TaskListViewMode;
  driveFooterCollapsed: boolean;
  dashboardFooterCollapsed: boolean;
  pulseCollapsed: boolean;
  favoritesCollapsed: boolean;
  recentsCollapsed: boolean;

  // Mobile sheet state (NOT persisted - sheets start closed on page load)
  leftSheetOpen: boolean;
  rightSheetOpen: boolean;

  // Hydration state
  rehydrated: boolean;

  // Methods
  setRehydrated: () => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setRightSidebarOpen: (open: boolean) => void;
  setLeftSheetOpen: (open: boolean) => void;
  setRightSheetOpen: (open: boolean) => void;
  setTaskListViewMode: (mode: TaskListViewMode) => void;
  setDriveFooterCollapsed: (collapsed: boolean) => void;
  setDashboardFooterCollapsed: (collapsed: boolean) => void;
  setPulseCollapsed: (collapsed: boolean) => void;
  setFavoritesCollapsed: (collapsed: boolean) => void;
  setRecentsCollapsed: (collapsed: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      // Initial state
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      taskListViewMode: 'table',
      driveFooterCollapsed: true,
      dashboardFooterCollapsed: true,
      pulseCollapsed: false,
      favoritesCollapsed: false,
      recentsCollapsed: false,
      rehydrated: false,

      // Mobile sheet state (NOT persisted)
      leftSheetOpen: false,
      rightSheetOpen: false,

      setRehydrated: () => {
        set({ rehydrated: true });
      },

      setTaskListViewMode: (mode: TaskListViewMode) => {
        set({ taskListViewMode: mode });
      },

      toggleLeftSidebar: () => {
        set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen }));
      },

      toggleRightSidebar: () => {
        set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen }));
      },

      setLeftSidebarOpen: (open: boolean) => {
        set({ leftSidebarOpen: open });
      },

      setRightSidebarOpen: (open: boolean) => {
        set({ rightSidebarOpen: open });
      },

      setLeftSheetOpen: (open: boolean) => {
        set({ leftSheetOpen: open });
      },

      setRightSheetOpen: (open: boolean) => {
        set({ rightSheetOpen: open });
      },

      setDriveFooterCollapsed: (collapsed: boolean) => {
        set({ driveFooterCollapsed: collapsed });
      },

      setDashboardFooterCollapsed: (collapsed: boolean) => {
        set({ dashboardFooterCollapsed: collapsed });
      },

      setPulseCollapsed: (collapsed: boolean) => {
        set({ pulseCollapsed: collapsed });
      },

      setFavoritesCollapsed: (collapsed: boolean) => {
        set({ favoritesCollapsed: collapsed });
      },

      setRecentsCollapsed: (collapsed: boolean) => {
        set({ recentsCollapsed: collapsed });
      },
    }),
    {
      name: 'layout-storage',
      partialize: (state) => ({
        leftSidebarOpen: state.leftSidebarOpen,
        rightSidebarOpen: state.rightSidebarOpen,
        taskListViewMode: state.taskListViewMode,
        driveFooterCollapsed: state.driveFooterCollapsed,
        dashboardFooterCollapsed: state.dashboardFooterCollapsed,
        pulseCollapsed: state.pulseCollapsed,
        favoritesCollapsed: state.favoritesCollapsed,
        recentsCollapsed: state.recentsCollapsed,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setRehydrated();
      },
    }
  )
);
