/**
 * useTaskListPageFilter Tests
 * Verifies the TaskListView filter wiring reads from and writes to useLayoutStore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskListPageFilter } from '../useTaskListPageFilter';
import { useLayoutStore } from '@/stores/useLayoutStore';

const initialSnapshot = useLayoutStore.getState();

describe('useTaskListPageFilter', () => {
  beforeEach(() => {
    useLayoutStore.setState(
      { ...initialSnapshot, taskListPageFilters: {} },
      true,
    );
    localStorage.clear();
  });

  it('given no entry stored for the page, should default to "active"', () => {
    const { result } = renderHook(() => useTaskListPageFilter('page-1'));

    expect(result.current[0]).toBe('active');
  });

  it('given the store has a filter for the page, should return that filter', () => {
    useLayoutStore.setState({
      ...useLayoutStore.getState(),
      taskListPageFilters: { 'page-1': 'completed' },
    });

    const { result } = renderHook(() => useTaskListPageFilter('page-1'));

    expect(result.current[0]).toBe('completed');
  });

  it('given the setter is called, should write through to the store under that pageId', () => {
    const { result } = renderHook(() => useTaskListPageFilter('page-1'));

    act(() => {
      result.current[1]('active');
    });

    expect(useLayoutStore.getState().taskListPageFilters['page-1']).toBe('active');
    expect(result.current[0]).toBe('active');
  });

  it('given a different pageId, should not be affected by another page’s filter', () => {
    useLayoutStore.setState({
      ...useLayoutStore.getState(),
      taskListPageFilters: { 'page-other': 'completed' },
    });

    const { result } = renderHook(() => useTaskListPageFilter('page-1'));

    expect(result.current[0]).toBe('active');
  });
});
