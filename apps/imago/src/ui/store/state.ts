import type { ListSection } from '../frame/stage/stage';
import { defaultTaskView, type TaskViewName } from '../tasks/task-view/task-view';

/**
 * Scalar shell state (drafts, filters, expansion, the open conversation).
 * Section leaves add their fields here as they land.
 */
export type UiResources = {
  /** Sections whose list the viewer hid; the stage itself lives in the URL. */
  readonly collapsedSections: readonly ListSection[];
  /** The view an open task list shows; saved per viewer (useTaskView). */
  readonly taskView: TaskViewName;
  /** Tasks whose subtasks the Tree view shows. */
  readonly expandedTasks: readonly string[];
};

/**
 * Entity lists the shell renders (files, conversations, tasks). Real data
 * from later leaves fills these; there is no mock seed.
 */
export type UiCollections = Readonly<Record<never, never>>;

export type UiState = {
  readonly resources: UiResources;
  readonly collections: UiCollections;
};

/** The empty shell: the swap point for real data from later leaves. */
export const createInitialState = (): UiState => ({
  resources: { collapsedSections: [], taskView: defaultTaskView, expandedTasks: [] },
  collections: {},
});
