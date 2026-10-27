import type { UiSlice, UiState } from '../store/state';
import { defaultTaskView, type TaskViewName } from './task-view/task-view';

const withResources = (state: UiState, resources: Partial<UiState['resources']>): UiState => ({
  ...state,
  resources: { ...state.resources, ...resources },
});

/**
 * The Tasks section's view state: which view an open list shows (saved per
 * viewer by useTaskView) and which tasks the Tree view has open. The tasks
 * themselves live in SWR, not here.
 */
export const tasksPlugin = {
  resources: (): {
    /** The view an open task list shows; saved per viewer (useTaskView). */
    readonly taskView: TaskViewName;
    /** Tasks whose subtasks the Tree view shows. */
    readonly expandedTasks: readonly string[];
  } => ({ taskView: defaultTaskView, expandedTasks: [] }),
  transactions: {
    setTaskView: (state: UiState, taskView: TaskViewName): UiState =>
      state.resources.taskView === taskView ? state : withResources(state, { taskView }),
    toggleTaskExpanded: (state: UiState, taskId: string): UiState => {
      const { expandedTasks } = state.resources;
      return withResources(state, {
        expandedTasks: expandedTasks.includes(taskId)
          ? expandedTasks.filter((id) => id !== taskId)
          : [...expandedTasks, taskId],
      });
    },
  },
} satisfies UiSlice;
