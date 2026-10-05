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

import { useMemo, useRef } from 'react';
import useSWR, { type KeyedMutator } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import type { ApiClient } from '@/api/client';
import type { Assignee, TaskList } from '../task-model/task';
import { locate, type TaskLocation } from '../task-tree/task-tree';
import {
  addTask,
  moveTask,
  removeTask,
  setAssignees,
  setStatus,
  toggledAssignees,
  toggledStatus,
  uniqueAssignees,
  updateTask,
  type TaskPatch,
} from '../task-edit/task-edit';
import {
  createTask,
  deleteTask,
  fetchAssignable,
  fetchDriveTaskLists,
  fetchPageContent,
  fetchPageTrail,
  fetchTaskStatuses,
  loadTaskTree,
  reorderTasks,
  setTaskAssignees,
  setTaskStatus,
  updateTask as patchTask,
  type CreateTaskInput,
  type TaskAddress,
} from '../task-api/task-api';

/** A drive's task lists, for the list pane. */
export const useDriveTaskLists = (driveId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading } = useSWR(
    driveId === null ? null : (['imago:drive-task-lists', driveId] as const),
    ([, id]) => fetchDriveTaskLists(client, id),
  );
  return { lists: data, error: error as unknown, isLoading };
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
  const { data, error } = useSWR(pageId === null ? null : (['imago:page-trail', pageId] as const), ([, id]) =>
    fetchPageTrail(client, id),
  );
  return { trail: data, error: error as unknown };
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

  const status = (taskId: string, slug: string) =>
    onTask(taskId, (tree, at) =>
      outcome(setStatus(tree, taskId, slug, now()), () => setTaskStatus(client, at, slug)),
    );

  const assignees = (taskId: string, next: (current: readonly Assignee[]) => readonly Assignee[]) =>
    onTask(taskId, (tree, at, found) => {
      // The set shown and the set sent are one: deduplicated before either.
      const chosen = uniqueAssignees(next(found.task.assignees));
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
    move: (taskId, toIndex) =>
      run((tree) => {
        const moved = moveTask(tree, taskId, toIndex);
        const order = moved.order;
        return order === null ? { refusal: NOT_FOUND } : { list: moved.list, send: () => reorderTasks(client, order) };
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
  return { list, error: error as unknown, isLoading, actions };
};

