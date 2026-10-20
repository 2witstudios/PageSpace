// The task routes apps/web already has, called through imago's API client:
// the session cookie on every request, the CSRF token on every write, and
// apps/web's errors as ApiError (a refused completion is a 422 with code
// SUBTASKS_INCOMPLETE).

import type { ApiClient } from '@/api/client';
import type {
  ActivitiesResponse,
  ActivityResponse,
  AssignablesResponse,
  Assignee,
  BreadcrumbResponse,
  DriveTasksResponse,
  DueDateFilter,
  DrivePagesLsResponse,
  StatusGroupFilter,
  PageContentResponse,
  Priority,
  TaskItemResponse,
  TaskList,
  TaskListResponse,
  TaskListSummary,
  TaskStatus,
  TaskStatusesResponse,
  TaskTriggerResponse,
  TaskTriggersResponse,
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
  /** The viewer's own tasks in a drive, filtered by status group and due window. */
  driveTasks: (query: DriveTasksQuery) => {
    const params = new URLSearchParams({ context: 'drive', driveId: query.driveId, limit: String(query.limit) });
    if (query.statusGroup !== undefined) params.set('statusGroup', query.statusGroup);
    if (query.dueDateFilter !== undefined) params.set('dueDateFilter', query.dueDateFilter);
    if (query.offset !== undefined && query.offset > 0) params.set('offset', String(query.offset));
    return `/api/tasks?${params.toString()}`;
  },
  /** A task's agent triggers, keyed by the task's id (not its page's). */
  triggers: (taskId: string) => `/api/tasks/${segment(taskId)}/triggers`,
  /** A page's most recent activity, newest first. */
  activities: (pageId: string) => `/api/activities?context=page&pageId=${segment(pageId)}&limit=${ACTIVITY_LIMIT}`,
};

/** How many of a page's activities the detail lists. */
const ACTIVITY_LIMIT = 20;

/** What GET /api/tasks?context=drive is asked for. Without assignee params the route answers for the viewer. */
export type DriveTasksQuery = {
  readonly driveId: string;
  readonly limit: number;
  readonly statusGroup?: StatusGroupFilter;
  readonly dueDateFilter?: DueDateFilter;
  /** Rows to skip in the route's newest-updated-first order; the first page without it. */
  readonly offset?: number;
};

/** One status as PUT /tasks/statuses takes it: the whole row, with its limit. */
export type StatusUpdate = {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly group: TaskStatus['group'];
  readonly position: number;
  readonly wipLimit: number | null;
};

/** The viewer's tasks in a drive, as GET /api/tasks answers them. */
export const fetchDriveTasks = (client: ApiClient, query: DriveTasksQuery) =>
  client.apiFetch<DriveTasksResponse>(taskPaths.driveTasks(query));

/** The most rows a drive-wide read takes: ten of the route's 100-row pages. */
const DRIVE_TASKS_CAP = 1000;

/**
 * Every one of the viewer's tasks in a drive: the first page of GET
 * /api/tasks, then every further page at once, by offset, joining the rows
 * and each list's statuses in page order. The offsets come from the first
 * page's total and count the route's own rows, so a page the route left
 * short or empty (orphans it dropped) never ends the read early. The order is
 * newest-updated first, so a row touched during the read can land on two
 * pages (it is kept once) or slide onto a page already read and be missed
 * until the next read. Stops at 1000 rows, leaving `hasMore` set.
 */
export const fetchEveryDriveTask = async (client: ApiClient, query: DriveTasksQuery): Promise<DriveTasksResponse> => {
  const first = await fetchDriveTasks(client, { ...query, offset: undefined });
  const { total } = first.pagination;
  const end = Math.min(total, DRIVE_TASKS_CAP);
  const offsets: number[] = [];
  for (let offset = query.limit; query.limit > 0 && offset < end; offset += query.limit) offsets.push(offset);
  const rest = await Promise.all(offsets.map((offset) => fetchDriveTasks(client, { ...query, offset })));
  const pages = [first, ...rest];
  const tasks = new Map<string, DriveTasksResponse['tasks'][number]>();
  for (const row of pages.flatMap((page) => page.tasks)) if (!tasks.has(row.id)) tasks.set(row.id, row);
  return {
    tasks: [...tasks.values()],
    statusConfigsByTaskList: pages.reduce<NonNullable<DriveTasksResponse['statusConfigsByTaskList']>>(
      (configs, page) => ({ ...configs, ...page.statusConfigsByTaskList }),
      {},
    ),
    pagination: { total, limit: query.limit, offset: 0, hasMore: total > DRIVE_TASKS_CAP },
  };
};

/** How many of the viewer's tasks in a drive fall in a due window (all of them without one): the route's pagination.total. */
export const fetchDriveTaskCount = async (
  client: ApiClient,
  driveId: string,
  dueDateFilter?: DueDateFilter,
): Promise<number> =>
  (await fetchDriveTasks(client, { driveId, limit: 1, dueDateFilter })).pagination.total;

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
  readonly startDate?: string | null;
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
      ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
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

/** PUT /tasks/statuses: every status of a list, each with its work-in-progress limit. */
export const updateStatuses = (client: ApiClient, pageId: string, statuses: readonly StatusUpdate[]) =>
  client.apiFetch<TaskStatusesResponse>(taskPaths.statuses(pageId), { method: 'PUT', json: { statuses } });

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

/**
 * A task's triggers: GET answers 403 to a viewer who cannot edit the list,
 * which callers read as "hide the automations", not as a failure.
 */
export const fetchTaskTriggers = async (
  client: ApiClient,
  taskId: string,
): Promise<readonly TaskTriggerResponse[]> =>
  (await client.apiFetch<TaskTriggersResponse>(taskPaths.triggers(taskId))).triggers;

/** A page's newest activity: who did what and when, Imago's work included. */
export const fetchPageActivity = async (client: ApiClient, pageId: string): Promise<readonly ActivityResponse[]> =>
  (await client.apiFetch<ActivitiesResponse>(taskPaths.activities(pageId))).activities;
