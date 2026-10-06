// Which view an open task list shows, and where a viewer's choice is kept.
//
// The choice is a store resource (tasks-plugin.ts) saved to this browser's
// localStorage under the viewer's id, so two people signing in on one
// machine each get their own. Storage can refuse (private windows, blocked
// site data): then the choice lasts for the session and the default stands.

import type { Segment } from '../../components/segmented-control/segmented-control.render';

/** The canvases' three views of an open list. */
export type TaskViewName = 'focus' | 'tree' | 'board';

/** The view a viewer who never chose sees. */
export const defaultTaskView: TaskViewName = 'tree';

export const taskViews: readonly Segment<TaskViewName>[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'tree', label: 'Tree' },
  { value: 'board', label: 'Board' },
];

const names: readonly string[] = taskViews.map((view) => view.value);

const isTaskViewName = (value: string | null): value is TaskViewName =>
  value !== null && names.includes(value);

/** The two Storage calls the preference makes. */
export type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const taskViewKey = (viewerId: string): string => `imago:task-view:${viewerId}`;

/** This viewer's saved view; null when there is none, or storage refuses. */
export const readTaskView = (storage: ViewStorage | null, viewerId: string): TaskViewName | null => {
  try {
    const stored = storage?.getItem(taskViewKey(viewerId)) ?? null;
    return isTaskViewName(stored) ? stored : null;
  } catch {
    return null;
  }
};

/** Saves this viewer's view; a storage that refuses keeps it for the session only. */
export const writeTaskView = (storage: ViewStorage | null, viewerId: string, view: TaskViewName): void => {
  try {
    storage?.setItem(taskViewKey(viewerId), view);
  } catch {
    // The store still holds the choice; it just will not outlive the tab.
  }
};

/** The browser's localStorage, or null where reading it throws or there is none. */
export const browserStorage = (): ViewStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};
