'use client';

// What every Tasks surface reads and writes: a drive's task lists, a list's
// statuses, and a list's whole task tree with the edits PageSpace allows.
//
// A write is applied to the tree first, by the same pure edit a view would
// reason with, so a refusal the server would give (a parent with open
// subtasks, a blank title, a sixth level) is answered without a request. An
// accepted edit shows at once, is sent through the imago client (session and
// CSRF), rolls back if the server refuses after all, and the tree is then
// revalidated from the server either way.

import { useCallback, useMemo, useRef } from 'react';
import useSWR, { type KeyedMutator } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import type { ApiClient } from '@/api/client';
import type { Assignee, DriveTasksResponse, DueDateFilter, StatusGroupFilter, TaskList } from '../task-model/task';
import { statusesFrom } from '../task-model/from-api';
import { taskViews, type TaskViewId } from '../task-views/task-views';
import { doneStatus, locate, openStatus, type TaskLocation } from '../task-tree/task-tree';
import {
  addTask,
  moveTask,
  removeTask,
  setAssignees,
  setStatus,
  setWipLimit,
  toggledAssignees,
  toggledStatus,
  updateTask,
  type TaskPatch,
} from '../task-edit/task-edit';
import {
  createTask,
  deleteTask,
  fetchAssignable,
  fetchDriveTaskCount,
  fetchDriveTasks,
  fetchDriveTaskLists,
  fetchPageContent,
  fetchPagePermissions,
  fetchPageTrail,
  fetchPageActivity,
  fetchTaskStatuses,
  fetchTaskTriggers,
  loadTaskTree,
  reorderTasks,
  setTaskAssignees,
  setTaskStatus,
  updateStatuses,
  updateTask as patchTask,
  type CreateTaskInput,
  type TaskAddress,
} from '../task-api/task-api';

/** A drive's task lists, for the list pane. */
export const useDriveTaskLists = (driveId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(
    driveId === null ? null : (['imago:drive-task-lists', driveId] as const),
    ([, id]) => fetchDriveTaskLists(client, id),
  );
  /** Void action: asks the server again after a failure. */
  const retry = useCallback(() => void mutate(), [mutate]);
  return { lists: data, error: error as unknown, isLoading, retry };
};

/**
 * Whether the viewer may edit a page: true only on a definite yes. Read
 * before anything that saves on its own, so nothing is typed into a field
 * the server would refuse.
 */
export const usePageEditable = (pageId: string) => {
  const client = useApiClient();
  const { data } = useSWR(['imago:page-permissions', pageId] as const, ([, id]) => fetchPagePermissions(client, id));
  return data?.canEdit === true;
};

/** Who can be put on the drive's tasks, for the assignee picker. */
export const useAssignable = (driveId: string) => {
  const client = useApiClient();
  const { data, error } = useSWR(['imago:assignable', driveId] as const, ([, id]) => fetchAssignable(client, id));
  return { assignable: data, error: error as unknown };
};

/** Where a page sits in its drive; null asks nothing. */
export const usePageTrail = (pageId: string | null) => {
  const client = useApiClient();
  const { data, error, mutate } = useSWR(pageId === null ? null : (['imago:page-trail', pageId] as const), ([, id]) =>
    fetchPageTrail(client, id),
  );
  /** Void action: asks the server again after a failure. */
  const retry = useCallback(() => void mutate(), [mutate]);
  return { trail: data, error: error as unknown, retry };
};

/**
 * A task's description, read once: the editor owns it after that, so a
 * revalidation never replaces what is being typed.
 */
export const usePageContent = (pageId: string) => {
  const client = useApiClient();
  const { data, error } = useSWR(
    ['imago:page-content', pageId] as const,
    ([, id]) => fetchPageContent(client, id),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false },
  );
  return { content: data, error: error as unknown };
};

/** A list's own statuses, read without GET /tasks' lazy writes. */
export const useTaskStatuses = (pageId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading } = useSWR(
    pageId === null ? null : (['imago:task-statuses', pageId] as const),
    ([, id]) => fetchTaskStatuses(client, id),
  );
  return { statuses: data, error: error as unknown, isLoading };
};

/**
 * A task's agent triggers. `forbidden` is a viewer who cannot edit the list:
 * the automations are hidden for them, not reported as an error.
 */
export const useTaskTriggers = (taskId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(
    taskId === null ? null : (['imago:task-triggers', taskId] as const),
    ([, id]) => fetchTaskTriggers(client, id),
  );
  const forbidden = error instanceof ApiError && error.status === 403;
  /** Void action: asks the server again, e.g. after the dialog saved a trigger. */
  const reload = useCallback(() => void mutate(), [mutate]);
  return { triggers: data, forbidden, error: error as unknown, isLoading, reload };
};

/** A page's newest activity, as the detail's Activity section lists it. */
export const usePageActivity = (pageId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading } = useSWR(
    pageId === null ? null : (['imago:page-activity', pageId] as const),
    ([, id]) => fetchPageActivity(client, id),
  );
  return { activities: data, error: error as unknown, isLoading };
};

export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly refusal: string };

export type TaskActions = {
  /** A new task in a list: the root list's page, or the page of the task it goes under. */
  readonly create: (listPageId: string, input: CreateTaskInput) => Promise<ActionResult>;
  readonly update: (taskId: string, patch: TaskPatch) => Promise<ActionResult>;
  readonly setStatus: (taskId: string, status: string) => Promise<ActionResult>;
  readonly toggleComplete: (taskId: string) => Promise<ActionResult>;
  readonly setAssignees: (taskId: string, assignees: readonly Assignee[]) => Promise<ActionResult>;
  readonly toggleAssignee: (taskId: string, assignee: Assignee) => Promise<ActionResult>;
  readonly remove: (taskId: string) => Promise<ActionResult>;
  /** Moves a task to an index among its siblings. */
  readonly move: (taskId: string, toIndex: number) => Promise<ActionResult>;
  /**
   * Moves a task to a status and an index among its siblings in one gesture:
   * the Board's drop on a card. The status is saved first; a refused status
   * leaves the order alone.
   */
  readonly moveTo: (taskId: string, status: string, toIndex: number) => Promise<ActionResult>;
  /** Sets (or, with null, clears) a status's work-in-progress limit on the root list. */
  readonly setWipLimit: (slug: string, wipLimit: number | null) => Promise<ActionResult>;
};

/** A write worked out against the tree: refused, or the new tree and the request that saves it. */
type Plan = { readonly refusal: string } | { readonly list: TaskList; readonly send: () => Promise<unknown> };

const NOT_FOUND = 'Task not found';
const LOADING = 'Task list is still loading';
const OFFLINE = 'Could not reach PageSpace';

const now = () => new Date().toISOString();

const createActions = (
  client: ApiClient,
  current: () => TaskList | undefined,
  mutate: KeyedMutator<TaskList>,
): TaskActions => {
  let minted = 0;

  const run = async (plan: (tree: TaskList) => Plan): Promise<ActionResult> => {
    const tree = current();
    if (tree === undefined) return { ok: false, refusal: LOADING };
    const planned = plan(tree);
    if ('refusal' in planned) return { ok: false, refusal: planned.refusal };
    let result: ActionResult = { ok: true };
    try {
      await mutate(
        async () => {
          await planned.send();
          return undefined;
        },
        { optimisticData: planned.list, rollbackOnError: true, populateCache: false, revalidate: false },
      );
    } catch (error) {
      result = { ok: false, refusal: error instanceof ApiError ? error.message : OFFLINE };
    }
    // Saved or refused, the server now has the last word on the tree.
    await mutate();
    return result;
  };

  /** A write to one task, addressed to the list that holds it. */
  const onTask =
    (taskId: string, plan: (tree: TaskList, at: TaskAddress, found: TaskLocation) => Plan) =>
    (tree: TaskList): Plan => {
      const found = locate(tree, taskId);
      return found === undefined
        ? { refusal: NOT_FOUND }
        : plan(tree, { listPageId: found.list.pageId, taskId }, found);
    };

  const outcome = (
    edited: { readonly list: TaskList; readonly refusal?: string },
    send: () => Promise<unknown>,
  ): Plan => (edited.refusal === undefined ? { list: edited.list, send } : { refusal: edited.refusal });

  const reorder = (taskId: string, toIndex: number) => (tree: TaskList): Plan => {
    const moved = moveTask(tree, taskId, toIndex);
    const order = moved.order;
    return order === null ? { refusal: NOT_FOUND } : { list: moved.list, send: () => reorderTasks(client, order) };
  };

  const status = (taskId: string, slug: string) =>
    onTask(taskId, (tree, at) =>
      outcome(setStatus(tree, taskId, slug, now()), () => setTaskStatus(client, at, slug)),
    );

  const assignees = (taskId: string, next: (current: readonly Assignee[]) => readonly Assignee[]) =>
    onTask(taskId, (tree, at, found) => {
      // setAssignees and the request body (task-api assigneeIds) each keep every person or agent once.
      const chosen = next(found.task.assignees);
      return { list: setAssignees(tree, taskId, chosen), send: () => setTaskAssignees(client, at, chosen) };
    });

  return {
    create: (listPageId, input) =>
      run((tree) => {
        minted += 1;
        const draft = { ...input, listPageId, id: `pending-${minted}`, pageId: `pending-page-${minted}`, now: now() };
        return outcome(addTask(tree, draft), () => createTask(client, listPageId, input));
      }),
    update: (taskId, patch) =>
      run(onTask(taskId, (tree, at) => outcome(updateTask(tree, taskId, patch), () => patchTask(client, at, patch)))),
    setStatus: (taskId, slug) => run(status(taskId, slug)),
    toggleComplete: (taskId) =>
      run((tree) => {
        const slug = toggledStatus(tree, taskId);
        return slug === undefined ? { refusal: NOT_FOUND } : status(taskId, slug)(tree);
      }),
    setAssignees: (taskId, chosen) => run(assignees(taskId, () => chosen)),
    toggleAssignee: (taskId, assignee) =>
      run(assignees(taskId, (current) => toggledAssignees(current, assignee))),
    remove: (taskId) =>
      run(onTask(taskId, (tree, at) => ({ list: removeTask(tree, taskId), send: () => deleteTask(client, at) }))),
    move: (taskId, toIndex) => run(reorder(taskId, toIndex)),
    moveTo: async (taskId, slug, toIndex) => {
      const tree = current();
      const found = tree === undefined ? undefined : locate(tree, taskId);
      if (found !== undefined && found.task.status !== slug) {
        const moved = await run(status(taskId, slug));
        if (!moved.ok) return moved;
      }
      return run(reorder(taskId, toIndex));
    },
    setWipLimit: (slug, wipLimit) =>
      run((tree) => {
        const edited = setWipLimit(tree, slug, wipLimit);
        return outcome(edited, () =>
          updateStatuses(
            client,
            tree.pageId,
            edited.list.statuses.map(({ id, name, color, group, position, wipLimit: limit }) => ({
              id,
              name,
              color,
              group,
              position,
              wipLimit: limit,
            })),
          ),
        );
      }),
  };
};

/**
 * A task list and every subtask under it (five levels), under the page title
 * the list pane knows it by, with the writes a view can make to it.
 */
export const useTaskList = (pageId: string | null, title: string) => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(
    pageId === null ? null : (['imago:task-tree', pageId] as const),
    ([, id]) => loadTaskTree(client, id, title),
  );
  const list = useMemo(
    () => (data === undefined || data.title === title ? data : { ...data, title }),
    [data, title],
  );
  const latest = useRef(list);
  latest.current = list;
  const actions = useMemo(() => createActions(client, () => latest.current, mutate), [client, mutate]);
  /** Void action: asks the server again after a failure. */
  const retry = useCallback(() => void mutate(), [mutate]);
  return { list, error: error as unknown, isLoading, actions, retry };
};


/**
 * How many of the viewer's tasks each smart view holds, read from each view's
 * pagination.total. Undefined until every count has loaded.
 */
export const useTaskViewCounts = (driveId: string | null) => {
  const client = useApiClient();
  const { data, error } = useSWR(driveId === null ? null : (['imago:task-view-counts', driveId] as const), ([, id]) =>
    Promise.all(
      taskViews.map(async (view) => [view.id, await fetchDriveTaskCount(client, id, view.dueDateFilter)] as const),
    ).then((counts) => Object.fromEntries(counts) as Record<TaskViewId, number>),
  );
  return { counts: data, error: error as unknown };
};

/** The most rows the ground asks for in one request (the route's limit ceiling). */
const GROUND_PAGE_SIZE = 100;

/**
 * The viewer's tasks in a drive for the ground: one status group, one due
 * window (or none), the first page of the route's answer.
 */
export const useDriveTasks = (driveId: string, statusGroup: StatusGroupFilter, dueDateFilter: DueDateFilter | undefined) => {
  const client = useApiClient();
  const query = { driveId, statusGroup, dueDateFilter, limit: GROUND_PAGE_SIZE };
  const { data, error, isLoading, mutate } = useSWR(['imago:drive-tasks', query] as const, ([, q]) =>
    fetchDriveTasks(client, q),
  );
  /** Void action: asks the server again after a failure. */
  const retry = useCallback(() => void mutate(), [mutate]);
  const latest = useRef(data);
  latest.current = data;
  /**
   * Ticks a row (or unticks it) in the list that holds it, by that list's
   * own statuses. The row shows its new state at once and the drive's rows
   * are asked again either way; a refusal (open subtasks) comes back in the
   * server's words.
   */
  const toggleComplete = useCallback(
    async (taskId: string): Promise<ActionResult> => {
      const response = latest.current;
      const row = response?.tasks.find((entry) => entry.id === taskId);
      if (response === undefined || row === undefined) return { ok: false, refusal: NOT_FOUND };
      const statuses = statusesFrom(response.statusConfigsByTaskList?.[row.taskListPageId] ?? []);
      const done = row.statusGroup === 'done';
      const slug = statuses.length === 0 ? (done ? 'pending' : 'completed') : done ? openStatus(statuses) : doneStatus(statuses);
      const next = statuses.find((status) => status.slug === slug);
      const optimistic: DriveTasksResponse = {
        ...response,
        tasks: response.tasks.map((entry) =>
          entry.id === taskId
            ? {
                ...entry,
                status: slug,
                statusGroup: next?.group ?? (done ? 'todo' : 'done'),
                statusLabel: next?.name ?? entry.statusLabel,
                completedAt: done ? null : now(),
              }
            : entry,
        ),
      };
      let result: ActionResult = { ok: true };
      try {
        await mutate(
          async () => {
            await setTaskStatus(client, { listPageId: row.taskListPageId, taskId }, slug);
            return undefined;
          },
          { optimisticData: optimistic, rollbackOnError: true, populateCache: false, revalidate: false },
        );
      } catch (caught) {
        result = { ok: false, refusal: caught instanceof ApiError ? caught.message : OFFLINE };
      }
      await mutate();
      return result;
    },
    [client, mutate],
  );
  return { response: data, error: error as unknown, isLoading, retry, toggleComplete };
};
