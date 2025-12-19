/**
 * useUIStore Tests
 * Tests for UI state management - tree expansion and scroll position
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
      treeExpanded: new Set(),
      treeScrollPosition: 0,
    });
    mockLocalStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty tree expanded set', () => {
      const { treeExpanded } = useUIStore.getState();
      expect(treeExpanded.size).toBe(0);
    });

    it('given store is created, should have zero scroll position', () => {
      const { treeScrollPosition } = useUIStore.getState();
      expect(treeScrollPosition).toBe(0);
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
    it('given tree expansion change, should not affect scroll position', () => {
      useUIStore.setState({ treeScrollPosition: 150 });
      const { setTreeExpanded } = useUIStore.getState();

      setTreeExpanded('node-1', true);

      expect(useUIStore.getState().treeScrollPosition).toBe(150);
    });

    it('given scroll position change, should not affect tree expansion', () => {
      useUIStore.setState({ treeExpanded: new Set(['node-1', 'node-2']) });
      const { setTreeScrollPosition } = useUIStore.getState();

      setTreeScrollPosition(300);

      const { treeExpanded } = useUIStore.getState();
      expect(treeExpanded.has('node-1')).toBe(true);
      expect(treeExpanded.has('node-2')).toBe(true);
    });
  });
});
