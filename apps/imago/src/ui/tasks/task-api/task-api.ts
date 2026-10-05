// The task routes apps/web already has, called through imago's API client:
// the session cookie on every request, the CSRF token on every write, and
// apps/web's errors as ApiError (a refused completion is a 422 with code
// SUBTASKS_INCOMPLETE).

import type { ApiClient } from '@/api/client';
import type {
  Assignee,
  DrivePagesLsResponse,
  Priority,
  TaskItemResponse,
  TaskList,
  TaskListResponse,
  TaskListSummary,
  TaskStatus,
  TaskStatusesResponse,
} from '../task-model/task';
import { driveTaskLists, statusesFrom, taskListFrom } from '../task-model/from-api';
import { MAX_LEVELS, withSubtasks } from '../task-tree/task-tree';
import type { ReorderPlan, TaskPatch } from '../task-edit/task-edit';

const segment = encodeURIComponent;

export const taskPaths = {
  tasks: (pageId: string) => `/api/pages/${segment(pageId)}/tasks`,
  task: (pageId: string, taskId: string) => `/api/pages/${segment(pageId)}/tasks/${segment(taskId)}`,
  reorder: (pageId: string) => `/api/pages/${segment(pageId)}/tasks/reorder`,
  statuses: (pageId: string) => `/api/pages/${segment(pageId)}/tasks/statuses`,
  /** Every page of a drive, flat, with isTaskLinked. */
  drivePages: (driveId: string) => `/api/drives/${segment(driveId)}/pages?ls=true&recursive=true`,
};

/** The most GET /tasks returns in one page (query-spec.ts MAX_LIMIT). */
const PAGE_SIZE = 200;

/** The most PATCH /tasks/reorder accepts, so a loaded list can always be reordered whole. */
const MAX_TASKS = 5000;

/** Where a task's writes go: the page of the list holding it, then the task. */
export type TaskAddress = { readonly listPageId: string; readonly taskId: string };

export const fetchDriveTaskLists = async (
  client: ApiClient,
  driveId: string,
): Promise<readonly TaskListSummary[]> =>
  driveTaskLists(await client.apiFetch<DrivePagesLsResponse>(taskPaths.drivePages(driveId)));

/**
 * Every task of one list, paging through GET /tasks in position order. Stops
 * at the 5000 tasks reorder accepts, leaving `hasMore` set.
 */
export const fetchTaskList = async (client: ApiClient, pageId: string): Promise<TaskListResponse> => {
  const first = await client.apiFetch<TaskListResponse>(`${taskPaths.tasks(pageId)}?limit=${PAGE_SIZE}&offset=0`);
  let tasks = first.tasks;
  let hasMore = first.hasMore;
  while (hasMore && tasks.length < MAX_TASKS) {
    const next = await client.apiFetch<TaskListResponse>(
      `${taskPaths.tasks(pageId)}?limit=${PAGE_SIZE}&offset=${tasks.length}`,
    );
    tasks = [...tasks, ...next.tasks];
    hasMore = next.hasMore;
  }
  return { ...first, tasks, hasMore };
};

/** A list's own statuses from GET /tasks/statuses, which never writes. */
export const fetchTaskStatuses = async (client: ApiClient, pageId: string): Promise<readonly TaskStatus[]> =>
  statusesFrom((await client.apiFetch<TaskStatusesResponse>(taskPaths.statuses(pageId))).statusConfigs);

/**
 * A list and every subtask under it, five levels deep. A task's subtasks are
 * GET /tasks on the task's own page, each with that sub-list's statuses.
 *
 * Only tasks the server counts subtasks for are asked: GET /tasks creates a
 * task list row for any page it has not seen, so asking for every leaf would
 * write a list per leaf (the gate classic's useTaskSubTasks applies too).
 */
export const loadTaskTree = async (client: ApiClient, pageId: string, title: string): Promise<TaskList> => {
  const load = async (listPageId: string, listTitle: string, level: number): Promise<TaskList> => {
    const list = taskListFrom(listPageId, listTitle, await fetchTaskList(client, listPageId));
    if (level >= MAX_LEVELS) return list;
    const parents = list.tasks.filter((task) => task.subTaskCount > 0);
    const loaded = await Promise.all(parents.map((task) => load(task.pageId, task.title, level + 1)));
    return loaded.reduce((tree, subtasks) => withSubtasks(tree, subtasks.pageId, subtasks), list);
  };
  return load(pageId, title, 1);
};

const assigneeIds = (assignees: readonly Assignee[]) => assignees.map(({ type, id }) => ({ type, id }));

export type CreateTaskInput = {
  readonly title: string;
  readonly status?: string;
  readonly priority?: Priority;
  readonly dueDate?: string | null;
  readonly assignees?: readonly Assignee[];
};

/** POST /tasks: a new task, and its page, at the end of a list. */
export const createTask = (client: ApiClient, listPageId: string, input: CreateTaskInput) =>
  client.apiFetch<TaskItemResponse>(taskPaths.tasks(listPageId), {
    method: 'POST',
    json: {
      title: input.title,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      ...(input.assignees === undefined ? {} : { assigneeIds: assigneeIds(input.assignees) }),
    },
  });

const patchTask = (client: ApiClient, at: TaskAddress, json: Record<string, unknown>) =>
  client.apiFetch<TaskItemResponse>(taskPaths.task(at.listPageId, at.taskId), { method: 'PATCH', json });

/** PATCH a task's title, priority or due date. */
export const updateTask = (client: ApiClient, at: TaskAddress, patch: TaskPatch) =>
  patchTask(client, at, { ...patch });

/** PATCH a task's status; a completion the server refuses rejects with a 422. */
export const setTaskStatus = (client: ApiClient, at: TaskAddress, status: string) =>
  patchTask(client, at, { status });

/** PATCH everyone on a task: task_assignees is replaced with this set. */
export const setTaskAssignees = (client: ApiClient, at: TaskAddress, assignees: readonly Assignee[]) =>
  patchTask(client, at, { assigneeIds: assigneeIds(assignees) });

/** DELETE a task: its page is trashed and the task removed. */
export const deleteTask = (client: ApiClient, at: TaskAddress) =>
  client.apiFetch<{ success: boolean }>(taskPaths.task(at.listPageId, at.taskId), { method: 'DELETE' });

/** PATCH /tasks/reorder: every task's new position in one list. */
export const reorderTasks = (client: ApiClient, plan: ReorderPlan) =>
  client.apiFetch<{ success: boolean }>(taskPaths.reorder(plan.listPageId), {
    method: 'PATCH',
    json: { tasks: plan.tasks },
  });
