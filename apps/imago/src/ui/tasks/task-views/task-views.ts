// The Tasks index's smart views: the viewer's own tasks, narrowed to one
// due-date window (or none). The pane lists them with counts, and the ground
// shows the rows of the view picked, so the choice lives in one tiny store.

import { create } from 'zustand';
import type { DueDateFilter } from '../task-model/task';

/** A view's id: the viewer's tasks with no due window, or one window. */
export type TaskViewId = 'assigned' | DueDateFilter;

export type TaskView = {
  readonly id: TaskViewId;
  readonly label: string;
  /** The window GET /api/tasks filters by; none for "Assigned to me". */
  readonly dueDateFilter: DueDateFilter | undefined;
  /** A token class for the view's colour dot. */
  readonly dotClass: string;
  /** Whether a non-zero count reads as a warning (overdue). */
  readonly warn: boolean;
};

export const taskViews: readonly TaskView[] = [
  { id: 'assigned', label: 'Assigned to me', dueDateFilter: undefined, dotClass: 'bg-accent', warn: false },
  { id: 'overdue', label: 'Overdue', dueDateFilter: 'overdue', dotClass: 'bg-status-danger', warn: true },
  { id: 'today', label: 'Due today', dueDateFilter: 'today', dotClass: 'bg-status-warning', warn: false },
  { id: 'this_week', label: 'This week', dueDateFilter: 'this_week', dotClass: 'bg-status-warning', warn: false },
  { id: 'upcoming', label: 'Upcoming', dueDateFilter: 'upcoming', dotClass: 'bg-ink-faint', warn: false },
];

/** The view with this id; the assigned view when the id names none. */
export const viewFor = (id: TaskViewId): TaskView => taskViews.find((view) => view.id === id) ?? taskViews[0];

/** The ground's heading: the viewer's own tasks, or the window the view names. */
export const groundHeading = (id: TaskViewId): string => (id === 'assigned' ? 'Assigned to you' : viewFor(id).label);

export type TaskViewState = {
  readonly view: TaskViewId;
  readonly setView: (view: TaskViewId) => void;
};

/** The view picked on the Tasks index, shared by its pane and its ground. */
export const useTaskViewStore = create<TaskViewState>()((set) => ({
  view: 'assigned',
  setView: (view) => set({ view }),
}));
