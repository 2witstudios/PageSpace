'use client';

import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { patch } from '@/lib/auth/auth-fetch';
import type {
  TaskItem,
  TaskListData,
  TaskLocation,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { applyTaskPatchToPages, type TaskFieldPatch } from './task-cache-core';
import {
  recordSelfWrite,
  dropInFlightSelfWrite,
  classifyTaskEcho,
  type SelfWrite,
  type InboundTaskEvent,
} from './self-echo-core';
import { taskWriteErrorMessage, isRevisionConflict } from './task-write-errors';

/**
 * Shared machinery for task field writes across a whole task view.
 *
 * Two things have to be view-wide rather than per-row:
 *
 *  - The self-write log. Echo suppression asks "did THIS TAB make this write",
 *    and a nested row's write echoes to the same sockets as a top-level one, so
 *    one log serves every depth.
 *  - The deferred revalidation flag, for the case where an echo arrives before
 *    our own response and we cannot yet tell it from a foreign edit.
 *
 * What is per-row is the CACHE a write patches: the top-level list owns one
 * `TaskListData[]`, and every expanded node owns its own. `useTaskWriter` binds
 * the shared machinery to whichever cache the caller is rendering from.
 */

type PagesUpdater = (
  current: TaskListData[] | undefined,
) => Promise<TaskListData[] | undefined> | TaskListData[] | undefined;

type MutatePages = (
  data?: TaskListData[] | Promise<TaskListData[] | undefined> | PagesUpdater | undefined,
  opts?: {
    optimisticData?: TaskListData[]
      | ((current: TaskListData[] | undefined, displayed: TaskListData[] | undefined) => TaskListData[]);
    rollbackOnError?: boolean;
    revalidate?: boolean;
  },
) => Promise<TaskListData[] | undefined>;

export interface TaskWriteMachinery {
  /** Current user id, for telling our own socket events from everyone else's. */
  currentUserId: string | null | undefined;
  noteSelfWriteStart: (taskId: string) => void;
  noteSelfWriteSettled: (taskId: string, updatedAt: string | null) => void;
  /**
   * Classify an inbound task event. Returns true when the caller should
   * revalidate; false when the event was this tab's own echo (already applied,
   * or deferred until our write settles).
   */
  shouldRevalidateForEvent: (event: InboundTaskEvent) => boolean;
}

/**
 * Held by the view that owns `revalidateAll` — it needs
 * `shouldRevalidateForEvent` in its own socket effect — and handed to every
 * descendant on the task tree context.
 *
 * Deliberately NOT a React context of its own. It was one, and nothing rendered
 * the provider: the view held the machinery directly while nested rows read it
 * from a context that was never populated, so every expansion threw. A single
 * explicit parameter cannot be half-wired that way.
 */
export function useTaskWriteMachinery(
  currentUserId: string | null | undefined,
  revalidateAll: () => void,
): TaskWriteMachinery {
  // One write produces TWO echoes: broadcastTaskEvent posts separately to
  // `user:<id>:tasks` and to the page room, and a task view is in both.
  const selfWritesRef = useRef<SelfWrite[]>([]);
  const deferredRevalidateRef = useRef(false);

  const noteSelfWriteStart = useCallback((taskId: string) => {
    const now = Date.now();
    selfWritesRef.current = recordSelfWrite(
      selfWritesRef.current, { taskId, updatedAt: null, at: now }, now,
    );
  }, []);

  const noteSelfWriteSettled = useCallback((taskId: string, updatedAt: string | null) => {
    const now = Date.now();
    // A failed write must forget its in-flight record, or every later event for
    // that task is read as our own echo and dropped for the rest of the TTL.
    selfWritesRef.current = updatedAt
      ? recordSelfWrite(selfWritesRef.current, { taskId, updatedAt, at: now }, now)
      : dropInFlightSelfWrite(selfWritesRef.current, taskId);
    if (deferredRevalidateRef.current) {
      deferredRevalidateRef.current = false;
      revalidateAll();
    }
  }, [revalidateAll]);

  const shouldRevalidateForEvent = useCallback((event: InboundTaskEvent): boolean => {
    const verdict = classifyTaskEcho(selfWritesRef.current, event, currentUserId, Date.now());
    if (verdict === 'self') return false;
    if (verdict === 'self-in-flight') {
      // We cannot tell our own echo from a foreign edit that raced it. Dropping
      // it outright would swallow someone else's change, so remember to
      // revalidate once when our write settles.
      deferredRevalidateRef.current = true;
      return false;
    }
    return true;
  }, [currentUserId]);

  return useMemo(
    () => ({ currentUserId, noteSelfWriteStart, noteSelfWriteSettled, shouldRevalidateForEvent }),
    [currentUserId, noteSelfWriteStart, noteSelfWriteSettled, shouldRevalidateForEvent],
  );
}

export interface WriteTaskFieldParams {
  loc: TaskLocation;
  /** The PATCH body. */
  body: Record<string, unknown>;
  /**
   * What to show immediately. Pass `{}` for writes whose visible result the
   * request body cannot predict — assignee changes send ids and the row renders
   * hydrated relations, so there is nothing honest to show early.
   */
  optimistic: TaskFieldPatch;
  fallbackMessage: string;
}

export interface TaskWriter {
  writeTaskField: (params: WriteTaskFieldParams) => Promise<boolean>;
}

/**
 * Bind the view-wide write machinery to one cache.
 *
 * Both the optimistic value and the reconciled one are computed from the cache
 * SWR hands the updater, never from a snapshot captured at call time — a write
 * can resolve many renders after it started, and patching a stale array would
 * silently drop everything that landed in between.
 *
 * `onRevisionConflict` is the escape hatch for 409/428: the rollback would
 * restore data that is already stale, so the caller refetches instead.
 */
export function useTaskWriter(params: {
  mutatePages: MutatePages;
  /** The view-wide machinery from useTaskWriteMachinery. */
  machinery: TaskWriteMachinery;
  onRevisionConflict?: () => void;
}): TaskWriter {
  const { noteSelfWriteStart, noteSelfWriteSettled } = params.machinery;
  const { mutatePages, onRevisionConflict } = params;

  const writeTaskField = useCallback(async ({
    loc, body, optimistic, fallbackMessage,
  }: WriteTaskFieldParams): Promise<boolean> => {
    noteSelfWriteStart(loc.taskId);
    try {
      await mutatePages(
        async (current) => {
          const updated = await patch<TaskItem>(
            `/api/pages/${loc.listPageId}/tasks/${loc.taskId}`, body,
          );
          noteSelfWriteSettled(loc.taskId, updated?.updatedAt ?? null);
          // Reconcile onto the server's values rather than keeping the guess:
          // completedAt in particular is a server-stamped timestamp.
          return applyTaskPatchToPages(current, loc.taskId, {
            status: updated?.status,
            completedAt: updated?.completedAt,
            priority: updated?.priority,
            title: updated?.title,
            dueDate: updated?.dueDate,
            assignees: updated?.assignees,
            updatedAt: updated?.updatedAt,
          });
        },
        {
          optimisticData: (current) => applyTaskPatchToPages(current, loc.taskId, optimistic) ?? [],
          rollbackOnError: true,
          revalidate: false,
        },
      );
      return true;
    } catch (e) {
      noteSelfWriteSettled(loc.taskId, null);
      if (isRevisionConflict(e)) onRevisionConflict?.();
      toast.error(taskWriteErrorMessage(e, fallbackMessage));
      return false;
    }
  }, [mutatePages, onRevisionConflict, noteSelfWriteStart, noteSelfWriteSettled]);

  return { writeTaskField };
}
