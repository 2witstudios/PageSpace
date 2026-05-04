/**
 * useLayoutStore Tests
 * Tests for persisted layout/UI preferences.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore, type StoredDashboardFilters } from '../useLayoutStore';

const initialSnapshot = useLayoutStore.getState();

describe('useLayoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState(
      {
        ...initialSnapshot,
        taskListPageFilters: {},
        tasksDashboardFilters: {},
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

  describe('tasksDashboardFilters', () => {
    it('given no entries written, should default to an empty record', () => {
      expect(useLayoutStore.getState().tasksDashboardFilters).toEqual({});
    });

    it('given setTasksDashboardFilter called for the user scope, should store the filters', () => {
      const { setTasksDashboardFilter } = useLayoutStore.getState();
      const filters: StoredDashboardFilters = {
        assigneeFilter: 'all',
        status: 'in_progress',
        dueDateFilter: 'overdue',
      };

      setTasksDashboardFilter('user', filters);

      expect(useLayoutStore.getState().tasksDashboardFilters.user).toEqual(filters);
    });

    it('given two scope keys, should keep both entries independently', () => {
      const { setTasksDashboardFilter } = useLayoutStore.getState();

      setTasksDashboardFilter('user', { assigneeFilter: 'all' });
      setTasksDashboardFilter('drive:abc', { priority: 'high' });

      expect(useLayoutStore.getState().tasksDashboardFilters).toEqual({
        user: { assigneeFilter: 'all' },
        'drive:abc': { priority: 'high' },
      });
    });

    it('given partial filters, should round-trip the persisted shape exactly', () => {
      const { setTasksDashboardFilter } = useLayoutStore.getState();
      const partial: StoredDashboardFilters = { search: 'budget' };

      setTasksDashboardFilter('drive:xyz', partial);

      expect(useLayoutStore.getState().tasksDashboardFilters['drive:xyz']).toEqual(partial);
    });

    it('given the same scope set twice, should replace the previous value', () => {
      const { setTasksDashboardFilter } = useLayoutStore.getState();

      setTasksDashboardFilter('user', { assigneeFilter: 'all', status: 'pending' });
      setTasksDashboardFilter('user', { assigneeFilter: 'mine' });

      expect(useLayoutStore.getState().tasksDashboardFilters.user).toEqual({
        assigneeFilter: 'mine',
      });
    });
  });
});
