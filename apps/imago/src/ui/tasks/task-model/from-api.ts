// apps/web's task answers, mapped into imago's task model.

import { PageType } from '@pagespace/lib/client-safe';
import type {
  Assignee,
  DrivePagesLsResponse,
  Task,
  TaskItemResponse,
  TaskList,
  TaskListResponse,
  TaskListSummary,
  TaskStatus,
  TaskStatusConfigResponse,
} from './task';

/**
 * The statuses PageSpace seeds a new list with: DEFAULT_TASK_STATUSES in
 * packages/db/src/schema/tasks.ts, which a parity test holds this to. Copied
 * rather than imported so the browser bundle never loads the db schema.
 */
export const defaultStatuses: readonly TaskStatus[] = [
  { id: 'default-pending', slug: 'pending', name: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', group: 'todo', position: 0 },
  { id: 'default-in_progress', slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300', group: 'in_progress', position: 1 },
  { id: 'default-blocked', slug: 'blocked', name: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300', group: 'in_progress', position: 2 },
  { id: 'default-completed', slug: 'completed', name: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300', group: 'done', position: 3 },
];

/** A list's statuses in position order, as its dropdowns and board columns read them. */
export const statusesFrom = (configs: readonly TaskStatusConfigResponse[]): readonly TaskStatus[] =>
  [...configs]
    .sort((a, b) => a.position - b.position)
    .map(({ id, slug, name, color, group, position }) => ({ id, slug, name, color, group, position }));

/**
 * Everyone on a task. task_assignees is the source; a row from before it
 * existed has only the legacy single person and agent, which are read instead.
 */
export const assigneesOf = (item: TaskItemResponse): readonly Assignee[] => {
  const rows = item.assignees ?? [];
  if (rows.length > 0) {
    return rows.flatMap((row): Assignee[] => {
      if (row.userId) return [{ type: 'user', id: row.userId, name: row.user?.name ?? '' }];
      if (row.agentPageId) return [{ type: 'agent', id: row.agentPageId, name: row.agentPage?.title ?? '' }];
      return [];
    });
  }
  return [
    ...(item.assigneeId ? [{ type: 'user' as const, id: item.assigneeId, name: item.assignee?.name ?? '' }] : []),
    ...(item.assigneeAgentId
      ? [{ type: 'agent' as const, id: item.assigneeAgentId, name: item.assigneeAgent?.title ?? '' }]
      : []),
  ];
};

/**
 * A task from GET /tasks, or from a POST/PATCH answer, which carries no
 * derived counts: a task just created has no content and no subtasks.
 */
export const taskFromItem = (item: TaskItemResponse): Task => ({
  id: item.id,
  pageId: item.pageId,
  title: item.title,
  status: item.status,
  priority: item.priority,
  dueDate: item.dueDate,
  completedAt: item.completedAt,
  assignees: assigneesOf(item),
  position: item.position,
  hasContent: item.hasContent ?? false,
  subTaskCount: item.subTaskCount ?? 0,
  subTaskCompletedCount: item.subTaskCompletedCount ?? 0,
  updatedAt: item.updatedAt,
  subtasks: null,
});

/**
 * The list GET /tasks answered for a page. The title is the page's own: the
 * route's `taskList.title` is the task_lists row's, which is "Task List".
 */
export const taskListFrom = (pageId: string, title: string, body: TaskListResponse): TaskList => ({
  pageId,
  title,
  statuses: statusesFrom(body.statusConfigs),
  tasks: body.tasks.map(taskFromItem),
  hasMore: body.hasMore,
});

/**
 * A drive's task lists: its TASK_LIST pages, less the ones that are a task's
 * own page (the drive route's isTaskLinked), at any depth of the tree.
 */
export const driveTaskLists = (body: DrivePagesLsResponse): readonly TaskListSummary[] =>
  body.pages
    .filter((page) => page.type === PageType.TASK_LIST && !page.isTaskLinked)
    .map((page) => ({ pageId: page.id, title: page.title }));
