'use client';

import { useCallback, useEffect } from 'react';
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
  const statusConfigs = data?.statusConfigs ?? [];
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
    }): SelfTaskResponse => {
      const base = current ?? (data as SelfTaskResponse);
      return base?.task
        ? { ...base, task: { ...base.task, ...next, updatedAt: next.updatedAt ?? base.task.updatedAt } }
        : base;
    };

    const writeId = machinery.noteSelfWriteStart(task.id);
    try {
      await mutate(
        async (current) => {
          const updated = await patch<{ status: string; completedAt: string | null; updatedAt: string }>(
            `/api/pages/${listPageId}/tasks/${task.id}`, { status },
          );
          machinery.noteSelfWriteSettled(writeId, updated.updatedAt);
          return applyStatus(current, updated);
        },
        {
          optimisticData: (current) => applyStatus(current, {
            status,
            completedAt: isCompletedStatus(status, statusConfigs) ? new Date().toISOString() : null,
          }),
          rollbackOnError: true,
          revalidate: false,
        },
      );
    } catch (e) {
      machinery.noteSelfWriteSettled(writeId, null);
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
