// Builders for the apps/web response shapes the task tests feed in. Every
// field a route returns is present, so a mapping that reads the wrong one fails.

import type {
  Task,
  TaskItemResponse,
  TaskList,
  TaskListResponse,
  TaskStatus,
  TaskStatusConfigResponse,
} from './task';

export const statusConfig = (
  slug: string,
  group: TaskStatusConfigResponse['group'],
  position: number,
  overrides: Partial<TaskStatusConfigResponse> = {},
): TaskStatusConfigResponse => ({
  id: `cfg-${slug}`,
  taskListId: 'tl-1',
  name: slug,
  slug,
  color: 'bg-slate-100',
  group,
  position,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

/** PageSpace's four seeded statuses, as GET /tasks returns them. */
export const seededConfigs: readonly TaskStatusConfigResponse[] = [
  statusConfig('pending', 'todo', 0, { name: 'To Do' }),
  statusConfig('in_progress', 'in_progress', 1, { name: 'In Progress' }),
  statusConfig('blocked', 'in_progress', 2, { name: 'Blocked' }),
  statusConfig('completed', 'done', 3, { name: 'Done' }),
];

export const taskItem = (
  id: string,
  overrides: Partial<TaskItemResponse> = {},
): TaskItemResponse => ({
  id,
  userId: 'u-owner',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${id}`,
  title: `Task ${id}`,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  assignee: null,
  assigneeAgent: null,
  assignees: [],
  activeTriggerCount: 0,
  hasContent: false,
  subTaskCount: 0,
  subTaskCompletedCount: 0,
  ...overrides,
});

export const taskListResponse = (
  tasks: readonly TaskItemResponse[],
  overrides: Partial<TaskListResponse> = {},
): TaskListResponse => ({
  taskList: {
    id: 'tl-1',
    title: 'Task List',
    description: null,
    status: 'pending',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  tasks,
  statusConfigs: seededConfigs,
  hasMore: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Model builders, for the pure edits.

export const seededStatuses: readonly TaskStatus[] = seededConfigs.map(
  ({ id, slug, name, color, group, position }) => ({ id, slug, name, color, group, position }),
);

export const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  pageId: `page-${id}`,
  title: `Task ${id}`,
  status: 'pending',
  priority: 'medium',
  dueDate: null,
  completedAt: null,
  assignees: [],
  position: 0,
  hasContent: false,
  subTaskCount: 0,
  subTaskCompletedCount: 0,
  updatedAt: '2026-10-01T00:00:00.000Z',
  subtasks: null,
  ...overrides,
});

export const list = (
  pageId: string,
  tasks: readonly Task[],
  overrides: Partial<TaskList> = {},
): TaskList => ({
  pageId,
  title: pageId,
  statuses: seededStatuses,
  tasks,
  hasMore: false,
  ...overrides,
});

/** A parent task holding loaded subtasks, with the server's counts to match. */
export const parent = (
  id: string,
  children: readonly Task[],
  overrides: Partial<Task> = {},
): Task =>
  task(id, {
    subTaskCount: children.length,
    subTaskCompletedCount: children.filter((child) => child.completedAt !== null).length,
    subtasks: list(`page-${id}`, children, { title: `Task ${id}` }),
    ...overrides,
  });
