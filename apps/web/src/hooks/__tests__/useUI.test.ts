import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockExpanded = vi.hoisted(() => new Set<string>(['node-1', 'node-2']));
const mockScrollPosition = vi.hoisted(() => 42);
const mockSetTreeExpanded = vi.hoisted(() => vi.fn());
const mockSetTreeScrollPosition = vi.hoisted(() => vi.fn());

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      treeExpanded: mockExpanded,
      treeScrollPosition: mockScrollPosition,
      setTreeExpanded: mockSetTreeExpanded,
      setTreeScrollPosition: mockSetTreeScrollPosition,
    };
    return selector(state);
  }),
}));

import { useTreeState } from '../useUI';

describe('useTreeState', () => {
  beforeEach(() => {
    mockSetTreeExpanded.mockReset();
    mockSetTreeScrollPosition.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the expanded set from the store', () => {
    const { result } = renderHook(() => useTreeState());

    expect(result.current.expanded).toBe(mockExpanded);
  });

  it('should return the scrollPosition from the store', () => {
    const { result } = renderHook(() => useTreeState());

    expect(result.current.scrollPosition).toBe(42);
  });

  it('should pass through setExpanded from the store', () => {
    const { result } = renderHook(() => useTreeState());

    expect(result.current.setExpanded).toBe(mockSetTreeExpanded);
  });

  it('should pass through setScrollPosition from the store', () => {
    const { result } = renderHook(() => useTreeState());

    expect(result.current.setScrollPosition).toBe(mockSetTreeScrollPosition);
  });

  describe('isExpanded', () => {
    it('should return true when the node is in the expanded set', () => {
      const { result } = renderHook(() => useTreeState());

      expect(result.current.isExpanded('node-1')).toBe(true);
      expect(result.current.isExpanded('node-2')).toBe(true);
    });

    it('should return false when the node is not in the expanded set', () => {
      const { result } = renderHook(() => useTreeState());

      expect(result.current.isExpanded('node-3')).toBe(false);
      expect(result.current.isExpanded('nonexistent')).toBe(false);
    });
  });

  describe('toggleExpanded', () => {
    it('should call setExpanded with false when node is currently expanded', () => {
      const { result } = renderHook(() => useTreeState());

      act(() => {
        result.current.toggleExpanded('node-1');
      });

      // node-1 is in the set, so expanded.has('node-1') is true, !true = false
      expect(mockSetTreeExpanded).toHaveBeenCalledWith('node-1', false);
    });

    it('should call setExpanded with true when node is currently collapsed', () => {
      const { result } = renderHook(() => useTreeState());

      act(() => {
        result.current.toggleExpanded('node-3');
      });

      // node-3 is NOT in the set, so expanded.has('node-3') is false, !false = true
      expect(mockSetTreeExpanded).toHaveBeenCalledWith('node-3', true);
    });
  });

  describe('return shape', () => {
    it('should return all expected properties', () => {
      const { result } = renderHook(() => useTreeState());

      expect(result.current).toHaveProperty('expanded');
      expect(result.current).toHaveProperty('scrollPosition');
      expect(result.current).toHaveProperty('setExpanded');
      expect(result.current).toHaveProperty('setScrollPosition');
      expect(result.current).toHaveProperty('isExpanded');
      expect(result.current).toHaveProperty('toggleExpanded');
      expect(typeof result.current.isExpanded).toBe('function');
      expect(typeof result.current.toggleExpanded).toBe('function');
    });
  });
});
