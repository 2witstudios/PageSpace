'use client';

import { useEffect } from 'react';
import { getUiState, useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import { COLLAPSED_GROUPS_KEY, parseCollapsed, serializeCollapsed } from './message-groups';

const selectCollapsed = (state: UiState) => state.resources.collapsedMessageGroups;

/** localStorage, which can throw (private windows, blocked site data): the folds then last for the session. */
const storage = {
  read: (): string | null => {
    try {
      return window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    } catch {
      return null;
    }
  },
  write: (value: string): void => {
    try {
      window.localStorage.setItem(COLLAPSED_GROUPS_KEY, value);
    } catch {
      // The store still holds the folds; they just will not outlive the tab.
    }
  },
};

/**
 * The Messages pane's folded groups: the store resource, restored from this
 * browser once mounted and saved on every toggle. The server render and the
 * first client render show every group open, so the two never disagree.
 */
export const useCollapsedGroups = (): readonly [readonly string[], (key: string) => void] => {
  const collapsed = useUiState(selectCollapsed);
  useEffect(() => {
    const saved = storage.read();
    if (saved !== null) dispatch(transactions.restoreMessageGroups, parseCollapsed(saved));
  }, []);
  const toggle = (key: string) => {
    dispatch(transactions.toggleMessageGroup, key);
    storage.write(serializeCollapsed(selectCollapsed(getUiState())));
  };
  return [collapsed, toggle];
};
