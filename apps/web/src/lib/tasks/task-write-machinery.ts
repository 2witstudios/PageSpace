'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SWRInfiniteKeyedMutator } from 'swr/infinite';
import { toast } from 'sonner';
import { patch } from '@/lib/auth/auth-fetch';
import type {
  TaskItem,
  TaskListData,
  TaskLocation,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import {
  applyTaskPatchToPages, invertTaskPatch, revertTaskPatch, type TaskFieldPatch,
} from './task-cache-core';
import {
  startSelfWrite,
  settleSelfWrite,
  hasAnyInFlightSelfWrite,
  isSoleInFlightWriteForTask,
  isNewestWriteForTask,
  classifyTaskEcho,
  deferredEchoesNeedRevalidation,
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

/**
 * swr/infinite's own bound mutator. Using SWR's type rather than a hand-rolled
 * one keeps every option it supports available and lets both call sites pass
 * their `mutate` directly, with no cast to paper over a near-miss signature.
 */
type MutatePages = SWRInfiniteKeyedMutator<TaskListData[]>;

/** Cap on queued-but-unclassified echoes; see where it is applied. */
const MAX_DEFERRED_ECHOES = 200;

export interface TaskWriteMachinery {
  /** Registers a write and returns its id; pass that id back to settle it. */
  noteSelfWriteStart: (taskId: string) => number;
  /** Bookkeeping only — records the outcome. Does NOT revalidate; see flushDeferredRevalidate. */
  noteSelfWriteSettled: (writeId: number, updatedAt: string | null) => void;
  /**
   * At PAINT time: is what this write is about to displace a value the server
   * gave us, rather than another write's unconfirmed guess? Only then is an
   * inverse worth capturing. See isSoleInFlightWriteForTask.
   */
  canCaptureInverse: (writeId: number, taskId: string) => boolean;
  /**
   * At FAILURE time: does this write still own the row, or has a later one
   * taken it? See isNewestWriteForTask. A separate question from the one above,
   * asked over a different set — conflating the two is how the previous version
   * of this rule managed to be both too strict and too permissive at once.
   */
  stillOwnsTask: (writeId: number, taskId: string) => boolean;
  /**
   * Register a cache to refresh when a deferred echo turns out to be foreign.
   *
   * The queue is view-wide but each writer owns a different cache, and only one
   * writer's `finally` performs the flush — so a per-writer callback would miss
   * every other cache. Whoever flushes refreshes them all.
   *
   * That fan-out is the cost of not knowing WHICH cache the echo belonged to:
   * one such flush refreshes every expanded node, not one. It is bounded by how
   * many nodes are open and only happens when an echo arrived mid-write and
   * then failed to match any write this tab made. Returns an unregister
   * function.
   */
  registerCacheRefresher: (refresh: () => void) => () => void;
  /**
   * Refresh every registered node cache.
   *
   * For changes made through a surface that does not own the cache the result
   * renders from — the trigger dialog is the case: it is opened from a nested
   * row, and the bell it toggles is drawn from that node's own cache, which has
   * no revalidation trigger of its own. Refreshing the root list alone leaves
   * the bell wrong for the rest of the session.
   *
   * Not wired to inbound socket events: those never carry a foreign nested
   * change to this client in the first place (see TaskListView's handlers), so
   * fanning out there would only re-fetch every open node on the user's own
   * writes.
   */
  refreshNodeCaches: () => void;
  /**
   * Run the revalidation an echo deferred, if one is pending and no write is
   * still open. Refreshes the view and every registered cache.
   *
   * Separate from noteSelfWriteSettled, and called only AFTER the cache write
   * has committed. Revalidating from inside SWR's updater starts a refetch that
   * can land before the updater's return value is committed — and that commit
   * would then overwrite the foreign change the refetch just fetched, which is
   * the exact data loss the deferral exists to prevent. The same applies across
   * writes, hence the in-flight check: see hasAnyInFlightSelfWrite.
   */
  flushDeferredRevalidate: () => void;
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
  /**
   * Echoes we could not classify yet because our own write was still open.
   *
   * Kept as the events themselves rather than a boolean so they can be
   * re-classified once the writes settle: the server broadcasts before it
   * responds, so our OWN echo lands here routinely, and a boolean would turn
   * every click into a full revalidation.
   */
  const deferredEchoesRef = useRef<InboundTaskEvent[]>([]);
  /**
   * Set when the queue overflowed, because the cap drops the OLDEST events —
   * and the one foreign echo the flush is looking for may be exactly that one.
   * Forgetting it would turn "someone else edited this" into silence, so an
   * overflow counts as unaccounted-for on its own.
   */
  const deferredOverflowRef = useRef(false);
  const nextWriteIdRef = useRef(0);
  const cacheRefreshersRef = useRef(new Set<() => void>());

  const registerCacheRefresher = useCallback((refresh: () => void) => {
    const set = cacheRefreshersRef.current;
    set.add(refresh);
    return () => { set.delete(refresh); };
  }, []);

  const refreshNodeCaches = useCallback((): void => {
    // Guarded individually: one caller runs this from a `finally`, so a single
    // throwing refresher would otherwise skip the rest and replace that
    // function's result with a rejection.
    for (const refresh of cacheRefreshersRef.current) {
      try { refresh(); } catch { /* one stale cache must not block the others */ }
    }
  }, []);

  const noteSelfWriteStart = useCallback((taskId: string) => {
    const now = Date.now();
    const writeId = ++nextWriteIdRef.current;
    selfWritesRef.current = startSelfWrite(selfWritesRef.current, { writeId, taskId, at: now }, now);
    return writeId;
  }, []);

  const noteSelfWriteSettled = useCallback((writeId: number, updatedAt: string | null) => {
    selfWritesRef.current = settleSelfWrite(
      selfWritesRef.current, writeId, updatedAt, Date.now(),
    );
  }, []);

  const canCaptureInverse = useCallback((writeId: number, taskId: string): boolean =>
    isSoleInFlightWriteForTask(selfWritesRef.current, taskId, writeId), []);

  const stillOwnsTask = useCallback((writeId: number, taskId: string): boolean =>
    isNewestWriteForTask(selfWritesRef.current, taskId, writeId), []);

  const flushDeferredRevalidate = useCallback((): void => {
    if (deferredEchoesRef.current.length === 0) return;
    // Not while ANY write is still open. The queue is view-wide, so an unrelated
    // write settling would otherwise start the refetch while this one is still
    // inside its updater — and its commit would then overwrite the foreign
    // change the refetch just fetched. The queue survives, so whichever write
    // settles last performs the flush.
    const now = Date.now();
    if (hasAnyInFlightSelfWrite(selfWritesRef.current, now)) return;

    const queued = deferredEchoesRef.current;
    const overflowed = deferredOverflowRef.current;
    deferredEchoesRef.current = [];
    deferredOverflowRef.current = false;
    // Re-ask, now that the stamps are known. An echo that turns out to have
    // been ours needs nothing; only one still unaccounted for is a real
    // concurrent edit worth refetching for.
    const unaccountedFor = overflowed
      || deferredEchoesNeedRevalidation(selfWritesRef.current, queued, currentUserId, now);
    if (!unaccountedFor) return;
    revalidateAll();
    // Every open node's cache, not just the writer that happened to flush: the
    // echo could have belonged to any of them.
    refreshNodeCaches();
  }, [revalidateAll, currentUserId, refreshNodeCaches]);

  const shouldRevalidateForEvent = useCallback((event: InboundTaskEvent): boolean => {
    const verdict = classifyTaskEcho(selfWritesRef.current, event, currentUserId, Date.now());
    if (verdict === 'self') return false;
    if (verdict === 'self-in-flight') {
      // We cannot tell our own echo from a foreign edit that raced it YET.
      // Queue the event and ask again once our write has a stamp to compare.
      // Bounded like the write log: a write that never settles (a hung fetch)
      // means nothing drains this, and a chatty room would grow it without end.
      const next = [...deferredEchoesRef.current, event];
      if (next.length > MAX_DEFERRED_ECHOES) deferredOverflowRef.current = true;
      deferredEchoesRef.current = next.slice(-MAX_DEFERRED_ECHOES);
      return false;
    }
    return true;
  }, [currentUserId]);

  return useMemo(
    () => ({
      noteSelfWriteStart,
      noteSelfWriteSettled,
      canCaptureInverse,
      stillOwnsTask,
      registerCacheRefresher,
      refreshNodeCaches,
      flushDeferredRevalidate,
      shouldRevalidateForEvent,
    }),
    [currentUserId, noteSelfWriteStart, noteSelfWriteSettled, canCaptureInverse, stillOwnsTask,
     registerCacheRefresher, refreshNodeCaches, flushDeferredRevalidate, shouldRevalidateForEvent],
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
 * Writes paint through two SYNCHRONOUS functional mutates — one before the
 * request, one after — rather than SWR's `optimisticData` + async-updater pair.
 * That is not a style choice; the optimistic path cannot survive two writes
 * overlapping on one key, which a user produces just by ticking two checkboxes
 * in a row (the PATCH awaits two outbound realtime posts, so the window is
 * wide). In `swr@2.4.1`'s `internalMutate`:
 *
 *   • `optimisticData(committedData, …)` and `data(committedData)` are both
 *     handed the PRE-optimistic snapshot backed up in `state._c`, not what is
 *     on screen. So write B's optimistic value is computed from a cache that
 *     never saw write A — A's checkbox visibly un-ticks the moment B is
 *     clicked.
 *   • On resolve, `beforeMutationTs !== MUTATION[key][0]` makes a superseded
 *     mutation skip `populateCache` entirely. A's server response is then
 *     discarded, and B's commit writes `patch(committedData, B)` — with no A in
 *     it. A ends up displayed as open although the server has it complete.
 *
 * Nothing repairs that: `revalidate: false` is the point of this path, and the
 * echo suppressor drops A's own socket event as recognised-self. The root list
 * heals on its 5-minute interval; a nested sub-list, which has every
 * revalidation trigger off, never heals at all.
 *
 * A synchronous functional mutate has neither failure mode. It never sets `_c`,
 * so `committedData === displayedData` and the updater sees the live value; and
 * it commits inline, so there is no window in which a later write can supersede
 * it. Overlapping writes then compose in the order they land.
 *
 * The cost is rollback: `rollbackOnError` only exists for the optimistic path.
 * A failed write therefore revalidates its cache instead of being reversed —
 * one refetch on a path that is already showing the user an error toast, in
 * exchange for a success path that cannot silently lose a write.
 *
 * `onRevisionConflict` is the escape hatch for 409/428, where the caller wants
 * more than a refetch of this one cache.
 */
export function useTaskWriter(params: {
  mutatePages: MutatePages;
  /** The view-wide machinery from useTaskWriteMachinery. */
  machinery: TaskWriteMachinery;
  onRevisionConflict?: () => void;
  /**
   * Refresh THIS writer's own cache.
   *
   * The machinery's revalidation is the view's — the root list. A nested writer
   * patches a per-node cache that has every automatic revalidation turned off,
   * so without this a foreign edit that raced a nested write is dropped for
   * good rather than deferred, which is the opposite of what the deferral
   * promises. Registered with the machinery rather than called here, because
   * the writer that performs the flush is not necessarily the one whose cache
   * the echo belonged to. Omitted at the root, where the two are one cache.
   */
  refreshOwnCache?: () => void;
}): TaskWriter {
  const {
    noteSelfWriteStart, noteSelfWriteSettled, canCaptureInverse, stillOwnsTask,
    flushDeferredRevalidate, registerCacheRefresher,
  } = params.machinery;
  const { mutatePages, onRevisionConflict, refreshOwnCache } = params;

  useEffect(() => {
    if (!refreshOwnCache) return;
    return registerCacheRefresher(refreshOwnCache);
  }, [registerCacheRefresher, refreshOwnCache]);

  const writeTaskField = useCallback(async ({
    loc, body, optimistic, fallbackMessage,
  }: WriteTaskFieldParams): Promise<boolean> => {
    const writeId = noteSelfWriteStart(loc.taskId);
    // What the paint is about to overwrite, captured from the live cache so a
    // failure can be undone locally. Read inside the updater because that is
    // the only place SWR hands us the current value.
    //
    // Only trustworthy when this is the sole write open on the row: otherwise
    // what we are about to displace is another write's unconfirmed paint, and
    // restoring it would invent a state the server never agreed to.
    let inverse: TaskFieldPatch | null = null;
    const soleWriteAtPaint = canCaptureInverse(writeId, loc.taskId);
    try {
      // Paint first, synchronously, so the row changes in this tick — and so
      // the next write composes on top of this one instead of on a snapshot
      // taken before it. Awaited only to keep the two mutates ordered.
      await mutatePages((current) => {
        inverse = soleWriteAtPaint ? invertTaskPatch(current, loc.taskId, optimistic) : null;
        return applyTaskPatchToPages(current, loc.taskId, optimistic);
      }, { revalidate: false });
      const updated = await patch<TaskItem>(
        `/api/pages/${loc.listPageId}/tasks/${loc.taskId}`, body,
      );
      // Reconcile onto the server's values rather than keeping the guess:
      // completedAt in particular is a server-stamped timestamp.
      //
      // Settled AFTER this lands, not before. A write counts as resolved for the
      // undo rule precisely because its server values are in the cache — mark it
      // resolved first and a write painting in the gap between would capture the
      // optimistic guess and call it a server value.
      //
      // The trade, stated: a write painting DURING this window sees this one as
      // still open and so captures no inverse at all, losing its own local undo
      // if it later fails. That is the conservative side — no fabrication, only
      // a fallback to the refetch — which is why it is the one to be on.
      await mutatePages(
        (current) => applyTaskPatchToPages(current, loc.taskId, {
          status: updated?.status,
          completedAt: updated?.completedAt,
          priority: updated?.priority,
          title: updated?.title,
          dueDate: updated?.dueDate,
          assignees: updated?.assignees,
          updatedAt: updated?.updatedAt,
        }),
        { revalidate: false },
      );
      noteSelfWriteSettled(writeId, updated?.updatedAt ?? null);
      return true;
    } catch (e) {
      noteSelfWriteSettled(writeId, null);
      // Undo locally FIRST, and only then ask the server.
      //
      // A refetch alone is not an undo: the root list's SWR is configured
      // `isPaused: () => isAnyEditing`, and SWR returns early from every
      // revalidation while that holds — so with any editor open anywhere in the
      // app, the request is never issued and a fabricated completion would sit
      // on screen until the 5-minute interval, which is gated the same way.
      // The local revert is conditional twice over — the row must still hold
      // exactly what this write painted (revertTaskPatch), and no LATER write
      // may have taken the row since. Where either fails there is no honest
      // local answer, and the refetch is the only repair.
      await mutatePages(
        (current) => (stillOwnsTask(writeId, loc.taskId)
          ? revertTaskPatch(current, loc.taskId, optimistic, inverse)
          : current),
        { revalidate: false },
      );
      void mutatePages();
      if (isRevisionConflict(e)) onRevisionConflict?.();
      toast.error(taskWriteErrorMessage(e, fallbackMessage));
      return false;
    } finally {
      // After the cache write has committed, never from inside the updater.
      flushDeferredRevalidate();
    }
  }, [mutatePages, onRevisionConflict, noteSelfWriteStart, noteSelfWriteSettled,
      canCaptureInverse, stillOwnsTask, flushDeferredRevalidate]);

  return { writeTaskField };
}
