/**
 * useUIStore Tests
 * Tests for UI state management including sidebars, tree expansion, and navigation
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useUIStore } from '../useUIStore';

// Mock localStorage for persistence tests
const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useUIStore.setState({
      leftSidebarOpen: true,
      rightSidebarOpen: true,
      treeExpanded: new Set(),
      treeScrollPosition: 0,
      centerViewType: 'document',
      isNavigating: false,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have left sidebar open by default', () => {
      const { leftSidebarOpen } = useUIStore.getState();
      expect(leftSidebarOpen).toBe(true);
    });

    it('given store is created, should have right sidebar open by default', () => {
      const { rightSidebarOpen } = useUIStore.getState();
      expect(rightSidebarOpen).toBe(true);
    });

    it('given store is created, should have empty tree expanded set', () => {
      const { treeExpanded } = useUIStore.getState();
      expect(treeExpanded.size).toBe(0);
    });

    it('given store is created, should have document as default view type', () => {
      const { centerViewType } = useUIStore.getState();
      expect(centerViewType).toBe('document');
    });

    it('given store is created, should not be navigating', () => {
      const { isNavigating } = useUIStore.getState();
      expect(isNavigating).toBe(false);
    });
  });

  describe('toggleLeftSidebar', () => {
    it('given left sidebar is open, should close it', () => {
      useUIStore.setState({ leftSidebarOpen: true });
      const { toggleLeftSidebar } = useUIStore.getState();

      toggleLeftSidebar();

      expect(useUIStore.getState().leftSidebarOpen).toBe(false);
    });

    it('given left sidebar is closed, should open it', () => {
      useUIStore.setState({ leftSidebarOpen: false });
      const { toggleLeftSidebar } = useUIStore.getState();

      toggleLeftSidebar();

      expect(useUIStore.getState().leftSidebarOpen).toBe(true);
    });
  });

  describe('toggleRightSidebar', () => {
    it('given right sidebar is open, should close it', () => {
      useUIStore.setState({ rightSidebarOpen: true });
      const { toggleRightSidebar } = useUIStore.getState();

      toggleRightSidebar();

      expect(useUIStore.getState().rightSidebarOpen).toBe(false);
    });

    it('given right sidebar is closed, should open it', () => {
      useUIStore.setState({ rightSidebarOpen: false });
      const { toggleRightSidebar } = useUIStore.getState();

      toggleRightSidebar();

      expect(useUIStore.getState().rightSidebarOpen).toBe(true);
    });
  });

  describe('setLeftSidebar', () => {
    it('given true, should open left sidebar', () => {
      useUIStore.setState({ leftSidebarOpen: false });
      const { setLeftSidebar } = useUIStore.getState();

      setLeftSidebar(true);

      expect(useUIStore.getState().leftSidebarOpen).toBe(true);
    });

    it('given false, should close left sidebar', () => {
      useUIStore.setState({ leftSidebarOpen: true });
      const { setLeftSidebar } = useUIStore.getState();

      setLeftSidebar(false);

      expect(useUIStore.getState().leftSidebarOpen).toBe(false);
    });
  });

  describe('setRightSidebar', () => {
    it('given true, should open right sidebar', () => {
      useUIStore.setState({ rightSidebarOpen: false });
      const { setRightSidebar } = useUIStore.getState();

      setRightSidebar(true);

      expect(useUIStore.getState().rightSidebarOpen).toBe(true);
    });

    it('given false, should close right sidebar', () => {
      useUIStore.setState({ rightSidebarOpen: true });
      const { setRightSidebar } = useUIStore.getState();

      setRightSidebar(false);

      expect(useUIStore.getState().rightSidebarOpen).toBe(false);
    });
  });

  describe('setCenterViewType', () => {
    it('given document view type, should set it', () => {
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('document');

      expect(useUIStore.getState().centerViewType).toBe('document');
    });

    it('given folder view type, should set it', () => {
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('folder');

      expect(useUIStore.getState().centerViewType).toBe('folder');
    });

    it('given channel view type, should set it', () => {
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('channel');

      expect(useUIStore.getState().centerViewType).toBe('channel');
    });

    it('given ai view type, should set it', () => {
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('ai');

      expect(useUIStore.getState().centerViewType).toBe('ai');
    });

    it('given settings view type, should set it', () => {
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('settings');

      expect(useUIStore.getState().centerViewType).toBe('settings');
    });
  });

  describe('setNavigating', () => {
    it('given true, should set navigating state', () => {
      const { setNavigating } = useUIStore.getState();

      setNavigating(true);

      expect(useUIStore.getState().isNavigating).toBe(true);
    });

    it('given false, should clear navigating state', () => {
      useUIStore.setState({ isNavigating: true });
      const { setNavigating } = useUIStore.getState();

      setNavigating(false);

      expect(useUIStore.getState().isNavigating).toBe(false);
    });
  });

  describe('setTreeExpanded', () => {
    it('given a node ID and expanded=true, should add it to the set', () => {
      const { setTreeExpanded } = useUIStore.getState();

      setTreeExpanded('node-123', true);

      expect(useUIStore.getState().treeExpanded.has('node-123')).toBe(true);
    });

    it('given a node ID and expanded=false, should remove it from the set', () => {
      useUIStore.setState({ treeExpanded: new Set(['node-123']) });
      const { setTreeExpanded } = useUIStore.getState();

      setTreeExpanded('node-123', false);

      expect(useUIStore.getState().treeExpanded.has('node-123')).toBe(false);
    });

    it('given multiple nodes expanded, should track all of them', () => {
      const { setTreeExpanded } = useUIStore.getState();

      setTreeExpanded('node-1', true);
      setTreeExpanded('node-2', true);
      setTreeExpanded('node-3', true);

      const { treeExpanded } = useUIStore.getState();
      expect(treeExpanded.has('node-1')).toBe(true);
      expect(treeExpanded.has('node-2')).toBe(true);
      expect(treeExpanded.has('node-3')).toBe(true);
      expect(treeExpanded.size).toBe(3);
    });

    it('given collapsing a node, should not affect other nodes', () => {
      const { setTreeExpanded } = useUIStore.getState();

      setTreeExpanded('node-1', true);
      setTreeExpanded('node-2', true);
      setTreeExpanded('node-3', true);

      setTreeExpanded('node-2', false);

      const { treeExpanded } = useUIStore.getState();
      expect(treeExpanded.has('node-1')).toBe(true);
      expect(treeExpanded.has('node-2')).toBe(false);
      expect(treeExpanded.has('node-3')).toBe(true);
    });
  });

  describe('setTreeScrollPosition', () => {
    it('given a scroll position, should store it', () => {
      const { setTreeScrollPosition } = useUIStore.getState();

      setTreeScrollPosition(250);

      expect(useUIStore.getState().treeScrollPosition).toBe(250);
    });

    it('given position 0, should set it correctly', () => {
      useUIStore.setState({ treeScrollPosition: 100 });
      const { setTreeScrollPosition } = useUIStore.getState();

      setTreeScrollPosition(0);

      expect(useUIStore.getState().treeScrollPosition).toBe(0);
    });
  });

  describe('state independence', () => {
    it('given sidebar toggle, should not affect tree state', () => {
      const { setTreeExpanded, toggleLeftSidebar } = useUIStore.getState();

      setTreeExpanded('node-1', true);
      toggleLeftSidebar();

      expect(useUIStore.getState().treeExpanded.has('node-1')).toBe(true);
    });

    it('given view type change, should not affect sidebar state', () => {
      useUIStore.setState({ leftSidebarOpen: true, rightSidebarOpen: false });
      const { setCenterViewType } = useUIStore.getState();

      setCenterViewType('ai');

      expect(useUIStore.getState().leftSidebarOpen).toBe(true);
      expect(useUIStore.getState().rightSidebarOpen).toBe(false);
    });
  });
});
