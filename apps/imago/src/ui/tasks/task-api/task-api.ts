// The task routes apps/web already has, called through imago's API client:
// the session cookie on every request, the CSRF token on every write, and
// apps/web's errors as ApiError (a refused completion is a 422 with code
// SUBTASKS_INCOMPLETE).

import type { ApiClient } from '@/api/client';
import type {
  AssignablesResponse,
  Assignee,
  BreadcrumbResponse,
  DrivePagesLsResponse,
  PageContentResponse,
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
import { uniqueAssignees, type ReorderPlan, type TaskPatch } from '../task-edit/task-edit';

const segment = encodeURIComponent;

export const taskPaths = {
  tasks: (pageId: string) => `/api/pages/${segment(pageId)}/tasks`,
  task: (pageId: string, taskId: string) => `/api/pages/${segment(pageId)}/tasks/${segment(taskId)}`,
  reorder: (pageId: string) => `/api/pages/${segment(pageId)}/tasks/reorder`,
  statuses: (pageId: string) => `/api/pages/${segment(pageId)}/tasks/statuses`,
  /** Every page of a drive, flat, with isTaskLinked. */
  drivePages: (driveId: string) => `/api/drives/${segment(driveId)}/pages?ls=true&recursive=true`,
  /** A drive's members and the agents the viewer can see: who a task can go to. */
  assignees: (driveId: string) => `/api/drives/${segment(driveId)}/assignees`,
  /** A page's ancestors, top first, ending with the page. */
  breadcrumbs: (pageId: string) => `/api/pages/${segment(pageId)}/breadcrumbs`,
  /** What the viewer may do on a page. */
  permissions: (pageId: string) => `/api/pages/${segment(pageId)}/permissions/check`,
  /** A page itself: a task's description is its own page's content. */
  page: (pageId: string) => `/api/pages/${segment(pageId)}`,
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

/**
 * Everyone on a task, each person or agent once. task_assignees is unique per
 * (task, user) and per (task, agent), so a repeat the server is sent fails
 * the whole write instead of being ignored.
 */
const assigneeIds = (assignees: readonly Assignee[]) => uniqueAssignees(assignees).map(({ type, id }) => ({ type, id }));

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

/** Who can be put on a drive's tasks: its members, then the agents the viewer can see. */
export const fetchAssignable = async (client: ApiClient, driveId: string): Promise<readonly Assignee[]> =>
  (await client.apiFetch<AssignablesResponse>(taskPaths.assignees(driveId))).assignees.map(({ type, id, name }) => ({
    type,
    id,
    name,
  }));

/** One step of where a page sits. */
export type TrailEntry = { readonly id: string; readonly title: string };

/** Where a page sits: its ancestors from the top of the drive, ending with the page itself. */
export const fetchPageTrail = async (client: ApiClient, pageId: string): Promise<readonly TrailEntry[]> =>
  (await client.apiFetch<readonly BreadcrumbResponse[]>(taskPaths.breadcrumbs(pageId))).map(({ id, title }) => ({
    id,
    title,
  }));

/** A task's description: its own page's content, empty when it has none. */
export const fetchPageContent = async (client: ApiClient, pageId: string): Promise<string> =>
  (await client.apiFetch<PageContentResponse>(taskPaths.page(pageId))).content ?? '';

/** PATCH a task's own page with a new description. */
export const savePageContent = (client: ApiClient, pageId: string, content: string) =>
  client.apiFetch<unknown>(taskPaths.page(pageId), { method: 'PATCH', json: { content } });

/** What GET /api/pages/[pageId]/permissions/check answers. */
export type PagePermissions = {
  readonly canView: boolean;
  readonly canEdit: boolean;
  readonly canShare: boolean;
  readonly canDelete: boolean;
};

/** What the viewer may do on a page. */
export const fetchPagePermissions = (client: ApiClient, pageId: string) =>
  client.apiFetch<PagePermissions>(taskPaths.permissions(pageId));
