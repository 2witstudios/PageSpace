/**
 * useLayoutStore Tests
 * Tests for persisted layout/UI preferences.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from '../useLayoutStore';

const initialSnapshot = useLayoutStore.getState();

describe('useLayoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState(
      {
        ...initialSnapshot,
        taskListPageFilters: {},
      },
      true,
    );
    localStorage.clear();
  });

  describe('taskListPageFilters', () => {
    it('given no entries written, should default to an empty record', () => {
      expect(useLayoutStore.getState().taskListPageFilters).toEqual({});
    });

    it('given setTaskListPageFilter called for a pageId, should store the value under that key', () => {
      const { setTaskListPageFilter } = useLayoutStore.getState();

      setTaskListPageFilter('page-a', 'completed');

      expect(useLayoutStore.getState().taskListPageFilters).toEqual({
        'page-a': 'completed',
      });
    });

    it('given two different pageIds, should keep both entries independently', () => {
      const { setTaskListPageFilter } = useLayoutStore.getState();

      setTaskListPageFilter('page-a', 'active');
      setTaskListPageFilter('page-b', 'completed');

      expect(useLayoutStore.getState().taskListPageFilters).toEqual({
        'page-a': 'active',
        'page-b': 'completed',
      });
    });

    it('given the same pageId set twice, should overwrite the previous value', () => {
      const { setTaskListPageFilter } = useLayoutStore.getState();

      setTaskListPageFilter('page-a', 'active');
      setTaskListPageFilter('page-a', 'completed');

      expect(useLayoutStore.getState().taskListPageFilters['page-a']).toBe('completed');
    });
  });
});
