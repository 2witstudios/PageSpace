/**
 * useLayoutStore Tests
 * Tests for UI layout state management including sidebars, sheets, and panel collapse states
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from '../useLayoutStore';

describe('useLayoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      taskListViewMode: 'table',
      driveFooterCollapsed: true,
      dashboardFooterCollapsed: true,
      pulseCollapsed: false,
      favoritesCollapsed: false,
      recentsCollapsed: false,
      leftSheetOpen: false,
      rightSheetOpen: false,
      rehydrated: false,
    });
  });

  describe('initial state', () => {
    it('should have left sidebar open by default', () => {
      expect(useLayoutStore.getState().leftSidebarOpen).toBe(true);
    });

    it('should have right sidebar closed by default', () => {
      expect(useLayoutStore.getState().rightSidebarOpen).toBe(false);
    });

    it('should have task list view mode set to table', () => {
      expect(useLayoutStore.getState().taskListViewMode).toBe('table');
    });

    it('should have drive footer collapsed by default', () => {
      expect(useLayoutStore.getState().driveFooterCollapsed).toBe(true);
    });

    it('should have dashboard footer collapsed by default', () => {
      expect(useLayoutStore.getState().dashboardFooterCollapsed).toBe(true);
    });

    it('should have pulse not collapsed by default', () => {
      expect(useLayoutStore.getState().pulseCollapsed).toBe(false);
    });

    it('should have favorites not collapsed by default', () => {
      expect(useLayoutStore.getState().favoritesCollapsed).toBe(false);
    });

    it('should have recents not collapsed by default', () => {
      expect(useLayoutStore.getState().recentsCollapsed).toBe(false);
    });

    it('should have left sheet closed by default', () => {
      expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
    });

    it('should have right sheet closed by default', () => {
      expect(useLayoutStore.getState().rightSheetOpen).toBe(false);
    });

    it('should have rehydrated set to false initially', () => {
      expect(useLayoutStore.getState().rehydrated).toBe(false);
    });
  });

  describe('toggleLeftSidebar', () => {
    it('should close the left sidebar when it is open', () => {
      const { toggleLeftSidebar } = useLayoutStore.getState();

      toggleLeftSidebar();

      expect(useLayoutStore.getState().leftSidebarOpen).toBe(false);
    });

    it('should open the left sidebar when it is closed', () => {
      useLayoutStore.setState({ leftSidebarOpen: false });

      useLayoutStore.getState().toggleLeftSidebar();

      expect(useLayoutStore.getState().leftSidebarOpen).toBe(true);
    });

    it('should toggle back and forth correctly', () => {
      const { toggleLeftSidebar } = useLayoutStore.getState();

      toggleLeftSidebar(); // true -> false
      expect(useLayoutStore.getState().leftSidebarOpen).toBe(false);

      useLayoutStore.getState().toggleLeftSidebar(); // false -> true
      expect(useLayoutStore.getState().leftSidebarOpen).toBe(true);
    });
  });

  describe('toggleRightSidebar', () => {
    it('should open the right sidebar when it is closed', () => {
      useLayoutStore.getState().toggleRightSidebar();

      expect(useLayoutStore.getState().rightSidebarOpen).toBe(true);
    });

    it('should close the right sidebar when it is open', () => {
      useLayoutStore.setState({ rightSidebarOpen: true });

      useLayoutStore.getState().toggleRightSidebar();

      expect(useLayoutStore.getState().rightSidebarOpen).toBe(false);
    });
  });

  describe('setLeftSidebarOpen', () => {
    it('should set left sidebar to open', () => {
      useLayoutStore.setState({ leftSidebarOpen: false });

      useLayoutStore.getState().setLeftSidebarOpen(true);

      expect(useLayoutStore.getState().leftSidebarOpen).toBe(true);
    });

    it('should set left sidebar to closed', () => {
      useLayoutStore.getState().setLeftSidebarOpen(false);

      expect(useLayoutStore.getState().leftSidebarOpen).toBe(false);
    });
  });

  describe('setRightSidebarOpen', () => {
    it('should set right sidebar to open', () => {
      useLayoutStore.getState().setRightSidebarOpen(true);

      expect(useLayoutStore.getState().rightSidebarOpen).toBe(true);
    });

    it('should set right sidebar to closed', () => {
      useLayoutStore.setState({ rightSidebarOpen: true });

      useLayoutStore.getState().setRightSidebarOpen(false);

      expect(useLayoutStore.getState().rightSidebarOpen).toBe(false);
    });
  });

  describe('setLeftSheetOpen', () => {
    it('should open the left sheet', () => {
      useLayoutStore.getState().setLeftSheetOpen(true);

      expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
    });

    it('should close the left sheet', () => {
      useLayoutStore.setState({ leftSheetOpen: true });

      useLayoutStore.getState().setLeftSheetOpen(false);

      expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
    });
  });

  describe('setRightSheetOpen', () => {
    it('should open the right sheet', () => {
      useLayoutStore.getState().setRightSheetOpen(true);

      expect(useLayoutStore.getState().rightSheetOpen).toBe(true);
    });

    it('should close the right sheet', () => {
      useLayoutStore.setState({ rightSheetOpen: true });

      useLayoutStore.getState().setRightSheetOpen(false);

      expect(useLayoutStore.getState().rightSheetOpen).toBe(false);
    });
  });

  describe('setTaskListViewMode', () => {
    it('should set view mode to kanban', () => {
      useLayoutStore.getState().setTaskListViewMode('kanban');

      expect(useLayoutStore.getState().taskListViewMode).toBe('kanban');
    });

    it('should set view mode to table', () => {
      useLayoutStore.setState({ taskListViewMode: 'kanban' });

      useLayoutStore.getState().setTaskListViewMode('table');

      expect(useLayoutStore.getState().taskListViewMode).toBe('table');
    });
  });

  describe('setDriveFooterCollapsed', () => {
    it('should expand the drive footer', () => {
      useLayoutStore.getState().setDriveFooterCollapsed(false);

      expect(useLayoutStore.getState().driveFooterCollapsed).toBe(false);
    });

    it('should collapse the drive footer', () => {
      useLayoutStore.setState({ driveFooterCollapsed: false });

      useLayoutStore.getState().setDriveFooterCollapsed(true);

      expect(useLayoutStore.getState().driveFooterCollapsed).toBe(true);
    });
  });

  describe('setDashboardFooterCollapsed', () => {
    it('should expand the dashboard footer', () => {
      useLayoutStore.getState().setDashboardFooterCollapsed(false);

      expect(useLayoutStore.getState().dashboardFooterCollapsed).toBe(false);
    });

    it('should collapse the dashboard footer', () => {
      useLayoutStore.setState({ dashboardFooterCollapsed: false });

      useLayoutStore.getState().setDashboardFooterCollapsed(true);

      expect(useLayoutStore.getState().dashboardFooterCollapsed).toBe(true);
    });
  });

  describe('setPulseCollapsed', () => {
    it('should collapse pulse', () => {
      useLayoutStore.getState().setPulseCollapsed(true);

      expect(useLayoutStore.getState().pulseCollapsed).toBe(true);
    });

    it('should expand pulse', () => {
      useLayoutStore.setState({ pulseCollapsed: true });

      useLayoutStore.getState().setPulseCollapsed(false);

      expect(useLayoutStore.getState().pulseCollapsed).toBe(false);
    });
  });

  describe('setFavoritesCollapsed', () => {
    it('should collapse favorites', () => {
      useLayoutStore.getState().setFavoritesCollapsed(true);

      expect(useLayoutStore.getState().favoritesCollapsed).toBe(true);
    });

    it('should expand favorites', () => {
      useLayoutStore.setState({ favoritesCollapsed: true });

      useLayoutStore.getState().setFavoritesCollapsed(false);

      expect(useLayoutStore.getState().favoritesCollapsed).toBe(false);
    });
  });

  describe('setRecentsCollapsed', () => {
    it('should collapse recents', () => {
      useLayoutStore.getState().setRecentsCollapsed(true);

      expect(useLayoutStore.getState().recentsCollapsed).toBe(true);
    });

    it('should expand recents', () => {
      useLayoutStore.setState({ recentsCollapsed: true });

      useLayoutStore.getState().setRecentsCollapsed(false);

      expect(useLayoutStore.getState().recentsCollapsed).toBe(false);
    });
  });

  describe('setRehydrated', () => {
    it('should set rehydrated to true', () => {
      useLayoutStore.getState().setRehydrated();

      expect(useLayoutStore.getState().rehydrated).toBe(true);
    });

    it('should remain true after being set', () => {
      useLayoutStore.getState().setRehydrated();
      useLayoutStore.getState().setRehydrated();

      expect(useLayoutStore.getState().rehydrated).toBe(true);
    });
  });

  describe('state independence', () => {
    it('should not affect right sidebar when toggling left sidebar', () => {
      useLayoutStore.setState({ rightSidebarOpen: true });

      useLayoutStore.getState().toggleLeftSidebar();

      expect(useLayoutStore.getState().rightSidebarOpen).toBe(true);
    });

    it('should not affect left sidebar when toggling right sidebar', () => {
      useLayoutStore.getState().toggleRightSidebar();

      expect(useLayoutStore.getState().leftSidebarOpen).toBe(true);
    });

    it('should not affect sheet state when toggling sidebars', () => {
      useLayoutStore.setState({ leftSheetOpen: true, rightSheetOpen: true });

      useLayoutStore.getState().toggleLeftSidebar();
      useLayoutStore.getState().toggleRightSidebar();

      expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
      expect(useLayoutStore.getState().rightSheetOpen).toBe(true);
    });
  });
});
