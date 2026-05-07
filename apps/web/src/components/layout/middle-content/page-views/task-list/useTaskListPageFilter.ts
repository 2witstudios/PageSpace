import { useCallback } from 'react';
import { useLayoutStore, type TaskListPageFilter } from '@/stores/useLayoutStore';

export function useTaskListPageFilter(
  pageId: string,
): [TaskListPageFilter, (next: TaskListPageFilter) => void] {
  const filter = useLayoutStore((s) => s.taskListPageFilters[pageId]) ?? 'active';
  const setStored = useLayoutStore((s) => s.setTaskListPageFilter);
  const setFilter = useCallback(
    (next: TaskListPageFilter) => setStored(pageId, next),
    [pageId, setStored],
  );
  return [filter, setFilter];
}
