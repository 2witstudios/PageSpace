// The Tasks ground's rows, read from GET /api/tasks (one drive, or on Home
// every drive): the viewer's own tasks, sectioned by when they fall due (Overdue, Due this week,
// Later), each with the fields a row shows. Nothing here is invented: every
// field is the route's, or derived from it by the viewer's own day.

import { assigneesOf } from '../task-model/from-api';
import type { Assignee, DriveTaskResponse, Priority, StatusGroup } from '../task-model/task';
import { dueLabel, dueToneOf, dueWindowOf, type DueWindow } from '../task-meta/task-meta';
import type { DueTone } from '../task-tree/task-tree';

export type GroundRow = {
  readonly id: string;
  /** The task's own page: where its title opens. */
  readonly pageId: string;
  readonly driveId: string;
  readonly title: string;
  readonly list: string;
  /** The task's drive by name, when the ground reads across drives; null on a drive's own ground. */
  readonly drive: string | null;
  readonly statusLabel: string;
  readonly statusGroup: StatusGroup;
  readonly done: boolean;
  readonly priority: Priority;
  readonly people: readonly Assignee[];
  readonly due: string;
  readonly dueTone: DueTone | null;
};

export type GroundSectionName = 'Overdue' | 'Due this week' | 'Later';

export type GroundSection = { readonly name: GroundSectionName; readonly rows: readonly GroundRow[] };

const SECTION_OF: Record<DueWindow, GroundSectionName> = {
  overdue: 'Overdue',
  this_week: 'Due this week',
  later: 'Later',
};

/**
 * One task as a row, read by `today` (YYYY-MM-DD, the viewer's own day). With
 * `driveNames` (Home, across drives) the row names its drive; a drive the list
 * does not name is left unnamed rather than guessed.
 */
export const groundRow = (task: DriveTaskResponse, today: string, driveNames?: ReadonlyMap<string, string>): GroundRow => {
  const done = task.statusGroup === 'done';
  return {
    id: task.id,
    pageId: task.pageId,
    driveId: task.driveId,
    title: task.title,
    list: task.taskListPageTitle,
    drive: driveNames?.get(task.driveId) ?? null,
    statusLabel: task.statusLabel,
    statusGroup: task.statusGroup,
    done,
    priority: task.priority,
    people: assigneesOf(task),
    due: dueLabel(task.dueDate, today),
    dueTone: dueToneOf(task.dueDate, today, done),
  };
};

/**
 * The tasks in their sections, in order. A section with no rows is still
 * returned, empty, so the caller decides whether to draw it.
 */
export const groundSections = (
  tasks: readonly DriveTaskResponse[],
  today: string,
  driveNames?: ReadonlyMap<string, string>,
): readonly GroundSection[] => {
  const sections: Record<GroundSectionName, GroundRow[]> = { Overdue: [], 'Due this week': [], Later: [] };
  for (const task of tasks) {
    const window = dueWindowOf(task.dueDate, today, task.statusGroup === 'done') ?? 'later';
    sections[SECTION_OF[window]].push(groundRow(task, today, driveNames));
  }
  return (['Overdue', 'Due this week', 'Later'] as const).map((name) => ({ name, rows: sections[name] }));
};

/** The lists the rows sit in: how many distinct ones, for the ground's subtitle. */
export const listCount = (tasks: readonly DriveTaskResponse[]): number => new Set(tasks.map((task) => task.taskListPageId)).size;
