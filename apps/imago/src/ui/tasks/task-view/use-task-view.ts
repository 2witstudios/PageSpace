'use client';

import { useEffect } from 'react';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import { browserStorage, defaultTaskView, readTaskView, writeTaskView, type TaskViewName } from './task-view';

const selectTaskView = (state: UiState) => state.resources.taskView;

/**
 * The viewer's task view: the store resource, restored from this browser on
 * mount and saved on every choice. The server render and the first client
 * render show the default; the saved choice follows once mounted, so the
 * two never disagree.
 */
export const useTaskView = (viewerId: string): readonly [TaskViewName, (view: TaskViewName) => void] => {
  const view = useUiState(selectTaskView);
  useEffect(() => {
    dispatch(transactions.setTaskView, readTaskView(browserStorage(), viewerId) ?? defaultTaskView);
  }, [viewerId]);
  const choose = (next: TaskViewName) => {
    dispatch(transactions.setTaskView, next);
    writeTaskView(browserStorage(), viewerId, next);
  };
  return [view, choose];
};
