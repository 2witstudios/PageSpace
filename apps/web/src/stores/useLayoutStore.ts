import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type TaskListViewMode = 'table' | 'kanban';
export type TaskListPageFilter = 'all' | 'active' | 'completed';

export interface StoredDashboardFilters {
  status?: string;
  priority?: 'low' | 'medium' | 'high';
  search?: string;
  dueDateFilter?: 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
  assigneeFilter?: 'mine' | 'all';
  statusGroup?: 'all' | 'active' | 'completed';
}

interface LayoutState {
  // UI panels state (PERSISTED)
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarSize: number;
  rightSidebarSize: number;
  taskListViewMode: TaskListViewMode;
  taskListPageFilters: Record<string, TaskListPageFilter>;
  tasksDashboardFilters: Record<string, StoredDashboardFilters>;
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
  setLeftSidebarSize: (size: number) => void;
  setRightSidebarSize: (size: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setRightSidebarOpen: (open: boolean) => void;
  setLeftSheetOpen: (open: boolean) => void;
  setRightSheetOpen: (open: boolean) => void;
  setTaskListViewMode: (mode: TaskListViewMode) => void;
  setTaskListPageFilter: (pageId: string, filter: TaskListPageFilter) => void;
  setTasksDashboardFilter: (scopeKey: string, filters: StoredDashboardFilters) => void;
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
      leftSidebarSize: 18,
      rightSidebarSize: 18,
      taskListViewMode: 'table',
      taskListPageFilters: {},
      tasksDashboardFilters: {},
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

      setLeftSidebarSize: (size) => set({ leftSidebarSize: size }),
      setRightSidebarSize: (size) => set({ rightSidebarSize: size }),

      setTaskListViewMode: (mode: TaskListViewMode) => {
        set({ taskListViewMode: mode });
      },

      setTaskListPageFilter: (pageId: string, filter: TaskListPageFilter) => {
        set((state) => ({
          taskListPageFilters: { ...state.taskListPageFilters, [pageId]: filter },
        }));
      },

      setTasksDashboardFilter: (scopeKey: string, filters: StoredDashboardFilters) => {
        set((state) => ({
          tasksDashboardFilters: { ...state.tasksDashboardFilters, [scopeKey]: filters },
        }));
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
        leftSidebarSize: state.leftSidebarSize,
        rightSidebarSize: state.rightSidebarSize,
        taskListViewMode: state.taskListViewMode,
        taskListPageFilters: state.taskListPageFilters,
        tasksDashboardFilters: state.tasksDashboardFilters,
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
