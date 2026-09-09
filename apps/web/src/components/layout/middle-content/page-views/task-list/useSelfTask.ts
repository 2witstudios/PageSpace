'use client';

import { useCallback, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { fetchWithAuth, patch } from '@/lib/auth/auth-fetch';
import {
  resolveToggleStatus,
  blockedByOpenSubTasks,
  blockedStatusTransition,
  subTasksBlockedMessage,
} from '@/lib/tasks/task-cache-core';
import { taskWriteErrorMessage } from '@/lib/tasks/task-write-errors';
import type { TaskFieldPatch } from '@/lib/tasks/task-cache-core';
import { isCompletedStatus, type TaskStatusConfig } from './task-list-types';
import type { TaskWriteMachinery } from '@/lib/tasks/task-write-machinery';

/** The SWR key for a page's own task row, so callers can refresh it. */
export const selfTaskKey = (pageId: string) => `/api/pages/${pageId}/task`;

/**
 * The task the currently-viewed page IS, if it is one.
 *
 * Opening a task renders a task list scoped to its CHILDREN — the task becomes
 * the container, and a container has no row of its own. So there was no way to
 * complete, or even see the status of, the task you were looking at; you had to
 * navigate back out to its parent list.
 */

export interface SelfTask {
  id: string;
  status: string;
  priority: string;
  completedAt: string | null;
  dueDate: string | null;
  updatedAt: string;
  subTaskCount: number;
  subTaskCompletedCount: number;
}

interface SelfTaskResponse {
  task: SelfTask | null;
  /** The parent list's page — where this task's writes are addressed. */
  listPageId: string | null;
  /** The parent list's vocabulary — what PATCH will validate the slug against. */
  statusConfigs: TaskStatusConfig[];
}

const fetcher = async (url: string): Promise<SelfTaskResponse> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch task');
  return res.json();
};

export interface UseSelfTaskResult {
  task: SelfTask | null;
  statusConfigs: TaskStatusConfig[];
  isCompleted: boolean;
  /** False while loading, or when the page is not a task at all. */
  isAvailable: boolean;
  setStatus: (status: string) => Promise<void>;
  toggleComplete: () => Promise<void>;
}

export function useSelfTask(
  pageId: string,
  canEdit: boolean,
  /**
   * The view's write machinery. Without it this write's socket echo matches no
   * recorded write, is classified foreign, and costs the list below a full
   * revalidation — the very refetch the checkbox path exists to avoid.
   */
  machinery: TaskWriteMachinery,
): UseSelfTaskResult {
  const { data, mutate } = useSWR<SelfTaskResponse>(
    selfTaskKey(pageId),
    fetcher,
    // A page's own task row changes when someone edits it from the parent list.
    // Refetching on focus is the cheap way to notice, and unlike the task list
    // route this endpoint has no write side effects.
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );

  // This key is its own cache, so a deferred foreign echo has to reach it —
  // whichever writer ends up performing the flush.
  const refresh = useCallback(() => { void mutate(); }, [mutate]);
  useEffect(() => machinery.registerCacheRefresher(refresh), [machinery, refresh]);

  const task = data?.task ?? null;
  // Memoized because `?? []` mints a new array on every render where `data` has
  // not arrived, and this is a dependency of both write callbacks — so they were
  // rebuilt on each of those renders, and so was anything holding their identity.
  const statusConfigs = useMemo(() => data?.statusConfigs ?? [], [data?.statusConfigs]);
  const listPageId = data?.listPageId ?? null;
  const isCompleted = !!task && isCompletedStatus(task.status, statusConfigs);

  const setStatus = useCallback(async (status: string) => {
    if (!task || !listPageId || !canEdit) return;
    // The dropdown can select a done status directly, which completes the task
    // just as the checkbox does — without this it optimistically completes and
    // then rolls back on the server's 422.
    const blocked = blockedStatusTransition(task, status, statusConfigs);
    if (blocked) {
      toast.error(subTasksBlockedMessage(blocked));
      return;
    }
    // Functional, not a render-time snapshot: a write can resolve several
    // renders after it started, and patching a captured object would drop
    // whatever landed in between (the same rule task-write-machinery follows).
    const applyStatus = (current: SelfTaskResponse | undefined, next: {
      status: string; completedAt: string | null; updatedAt?: string;
    }): SelfTaskResponse | undefined => {
      // No cast: `data` genuinely can be undefined, and asserting it away made
      // the declared return type a lie that only `base?.task` was covering.
      const base = current ?? data;
      return base?.task
        ? { ...base, task: { ...base.task, ...next, updatedAt: next.updatedAt ?? base.task.updatedAt } }
        : base;
    };

    const writeId = machinery.noteSelfWriteStart(task.id);
    const painted = {
      status,
      completedAt: isCompletedStatus(status, statusConfigs) ? new Date().toISOString() : null,
    };
    // The undo, and the two conditions that make it honest, are the writer's —
    // reimplemented here once, and the copy was weaker than the original: it
    // compared `status` alone but restored `completedAt` too, so it could
    // overwrite a server stamp with null. One rule, one implementation.
    const soleWriteAtPaint = machinery.canCaptureInverse(writeId, task.id);
    // A holder rather than a plain `let`: the assignment happens inside the
    // paint updater, which TypeScript's flow analysis cannot see, so a bare
    // binding narrows to `null` at every read below.
    const captured: { previous: TaskFieldPatch | null } = { previous: null };
    try {
      // Two synchronous mutates around the request rather than SWR's
      // optimisticData + async updater — see the header of
      // task-write-machinery for why that pair loses a write when two overlap
      // on one key. The header control is as easy to click twice as a row's
      // checkbox.
      await mutate((current) => {
        const before = (current ?? data)?.task;
        captured.previous = soleWriteAtPaint && before
          ? { status: before.status, completedAt: before.completedAt }
          : null;
        return applyStatus(current, painted);
      }, { revalidate: false });
      const updated = await patch<{ status: string; completedAt: string | null; updatedAt: string }>(
        `/api/pages/${listPageId}/tasks/${task.id}`, { status },
      );
      // Settled after the reconcile lands, not before — see the writer.
      await mutate((current) => applyStatus(current, updated), { revalidate: false });
      machinery.noteSelfWriteSettled(writeId, updated.updatedAt);
    } catch (e) {
      machinery.noteSelfWriteSettled(writeId, null);
      // Undo locally, then reconcile — see task-write-machinery's catch for why
      // a refetch alone is not an undo, and for what the two conditions rule
      // out. Whole-patch: if any painted field moved on, this write no longer
      // owns the row.
      const undo = captured.previous;
      await mutate((current) => {
        const row = current?.task;
        if (!undo || !row || !machinery.stillOwnsTask(writeId, task.id)) return current;
        const stillOurs = row.status === painted.status
          && row.completedAt === painted.completedAt;
        return stillOurs
          ? applyStatus(current, { status: undo.status ?? row.status, completedAt: undo.completedAt ?? null })
          : current;
      }, { revalidate: false });
      void mutate();
      toast.error(taskWriteErrorMessage(e, 'Failed to update status'));
    } finally {
      machinery.flushDeferredRevalidate();
    }
  }, [task, listPageId, canEdit, data, statusConfigs, mutate, machinery]);

  const toggleComplete = useCallback(async () => {
    if (!task) return;
    if (!isCompleted) {
      // The same guard the rows apply. The server enforces it too (422), but
      // saying so here avoids the round trip and the visible flip — and this is
      // exactly the screen where the open sub-tasks are listed below.
      const blocked = blockedByOpenSubTasks(task);
      if (blocked) {
        toast.error(subTasksBlockedMessage(blocked));
        return;
      }
    }
    await setStatus(resolveToggleStatus(statusConfigs, isCompleted));
  }, [task, isCompleted, statusConfigs, setStatus]);

  return {
    task,
    statusConfigs,
    isCompleted,
    isAvailable: !!task && !!listPageId,
    setStatus,
    toggleComplete,
  };
}
