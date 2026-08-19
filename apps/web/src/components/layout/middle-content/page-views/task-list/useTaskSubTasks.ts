'use client';

import { useCallback, useMemo } from 'react';
import useSWRInfinite from 'swr/infinite';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { TaskItem, TaskListData, TaskStatusConfig } from './task-list-types';

/**
 * Sub-tasks come from the SAME route the top-level list uses — called with the
 * task's own pageId instead of the list page's. Tasks are TASK_LIST pages (the
 * route selects children by `eq(pages.type, 'TASK_LIST')`), so a task's children
 * are its sub-tasks, already enriched with status/priority/assignees/dueDate,
 * `activeTriggerCount`, `hasContent` and their own `subTaskCount`. No new endpoint.
 *
 * The comment on `taskItems` in packages/db/src/schema/tasks.ts used to call that linked page a
 * DOCUMENT; this branch corrected it. If you find it saying DOCUMENT again, the route's own
 * filter is the authority.
 *
 * KNOWN COST OF THE GATE BELOW: `subTaskCount` is computed by joining task_items to child
 * pages, so a TASK_LIST child that has no task_items row yet counts as zero. A task whose
 * children are ALL in that state reads as a leaf here and will not expand, where an unguarded
 * fetch would have hit the route's own backfillMissingTaskItems and healed them. That is
 * accepted rather than overlooked: the alternative is fetching for every leaf, which is the
 * write amplification this gate exists to stop. Opening the task's own page still runs the
 * backfill, after which the count is right and the row expands.
 */

/**
 * Must stay <= the GET route's MAX_LIMIT (query-spec.ts, 200) or the server silently clamps
 * the page down while `offset` keeps advancing by this number — which skips rows rather than
 * failing.
 *
 * It equals TaskListView's own TASKS_PAGE_SIZE, and nothing requires it to: these are page
 * sizes for two different lists and either can change alone. But do not read "independent" as
 * "unrelated" — while the two are equal, the two hooks build the SAME request URL for the same
 * page, which is what made their SWR keys collide before SUB_TASKS_CACHE_NAMESPACE existed.
 * The namespace holds either way; this is only here so the next reader does not conclude from
 * "independent" that the URLs can never coincide.
 */
export const SUB_TASKS_PAGE_SIZE = 100;

/** The minimum a caller must know about a task to decide whether to fetch its children. */
export interface SubTaskGateInput {
  pageId: string | null;
  subTaskCount?: number;
}

/**
 * THE GATE. `GET /api/pages/[pageId]/tasks` has a write side effect:
 * `getOrCreateTaskListForPage` (route.ts:33) lazily inserts a `task_lists` row plus
 * 4 `task_status_configs` rows for any pageId it has not seen. Expanding 50 leaf
 * tasks would therefore create 50 task lists and 200 status-config rows for tasks
 * that have no children at all.
 *
 * `subTaskCount` is already on the row before expanding (it ships with the parent
 * list's own response), so refusing to fetch when it is 0 costs nothing and confines
 * those lazy writes to tasks that genuinely have sub-tasks.
 */
export const shouldFetchSubTasks = (task: SubTaskGateInput): boolean =>
  !!task.pageId && (task.subTaskCount ?? 0) > 0;

/**
 * The cache namespace. Not decoration: TaskListView pages the SAME route with the SAME page
 * size, so its page-0 key for a list page is byte-identical to this hook's page-0 key for a
 * task whose linked page IS that page — which happens as soon as someone opens a task's own
 * page and later expands that task from its parent list. Sharing a plain URL key would hand
 * both hooks one swr/infinite cache entry, including its page-count: the expansion would mount
 * at whatever size the full-page view had grown to and render hundreds of rows inside one
 * table cell, and TaskListView's 5-minute refreshInterval would refetch the very key this hook
 * promises never to refetch — re-running the route's lazy writes on a timer.
 *
 * SWR keys on the serialized key, so prefixing scopes the cache while leaving the request URL
 * exactly as it was.
 */
export const SUB_TASKS_CACHE_NAMESPACE = 'task-sub-tasks';

export type SubTaskPageKey = readonly [namespace: string, url: string];

/**
 * Built outside the hook so the gate is testable on its own and so the key is a
 * pure function of (task, enabled, pageIndex) — SWR caches per key, which is what
 * makes collapse → re-expand of the same task a cache hit rather than a refetch.
 */
export const getSubTaskPageKey = (task: SubTaskGateInput, enabled: boolean) =>
  (pageIndex: number, previousPageData: TaskListData | null): SubTaskPageKey | null => {
    if (!enabled || !shouldFetchSubTasks(task)) return null;
    if (previousPageData && !previousPageData.hasMore) return null;
    return [
      SUB_TASKS_CACHE_NAMESPACE,
      `/api/pages/${task.pageId}/tasks?limit=${SUB_TASKS_PAGE_SIZE}&offset=${pageIndex * SUB_TASKS_PAGE_SIZE}`,
    ] as const;
  };

/** Only the most recently loaded page's `hasMore` is current; earlier ones are stale bounds. */
export const getSubTasksHasMore = (pages: TaskListData[] | undefined): boolean =>
  !!pages && pages.length > 0 && pages[pages.length - 1].hasMore;

const fetcher = async ([, url]: SubTaskPageKey): Promise<TaskListData> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch sub-tasks');
  return res.json();
};

export interface UseTaskSubTasksOptions {
  /**
   * Callers mount this hook inside an expansion, so `enabled` normally just mirrors
   * "is this row expanded". Passing false keeps the key null — no request, and no
   * lazy task_list write on the server.
   */
  enabled?: boolean;
}

export interface UseTaskSubTasksResult {
  subTasks: TaskItem[];
  /**
   * The SUB-LIST's own status configs — status configs are per-task-list, so these come from
   * this task's list, not the root one.
   *
   * WARNING for whoever renders nested rows: do NOT feed these to a sub-task's status dropdown
   * by default. On a list whose statuses were customized, the sub-list has quietly received the
   * 4 defaults instead, so rendering these puts a different status vocabulary one level down
   * from its parent — visibly wrong with both on screen at once. The epic's decision is to
   * inherit the ROOT list's configs and diverge only on explicit customization. These are here
   * because that comparison needs both sides.
   */
  statusConfigs: TaskStatusConfig[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | undefined;
  loadMore: () => void;
  /**
   * Re-request the pages already asked for, clearing `error`. This is the ONLY revalidation
   * path the hook offers, and it exists because nothing retries on its own (see
   * shouldRetryOnError below) — without it a first page that fails is a dead end, since
   * `hasMore` is false at that point and "Load more" is not even on screen.
   *
   * Deliberately not a general refresh: it is meant to be wired to a user pressing "try
   * again" after a visible failure, which is the same class of explicit action as Load more.
   * Sub-task rows going stale when something changes elsewhere is a different problem with a
   * different answer (subscribing to the sub-list's own events, which belongs with recursive
   * expansion state) — do not solve that by calling this on a timer or a socket event.
   */
  retry: () => void;
}

export function useTaskSubTasks(
  task: SubTaskGateInput,
  { enabled = true }: UseTaskSubTasksOptions = {},
): UseTaskSubTasksResult {
  const gateOpen = enabled && shouldFetchSubTasks(task);

  const { data: pages, error, isLoading, size, setSize, mutate } = useSWRInfinite<TaskListData>(
    getSubTaskPageKey(task, enabled),
    fetcher,
    {
      // Expansion is disclosure of data the parent list already summarised — it does
      // not need to be live. Every revalidation trigger is off so that collapsing and
      // re-expanding a task is served entirely from SWR's cache: a refetch there would
      // not just cost a request, it would re-run the route's lazy task_list write path.
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      revalidateFirstPage: false,
      // SWR retries failed fetches on its own by default (5 attempts, exponential backoff).
      // That fights the rest of this config: every other automatic request is off precisely
      // because a request here can lazily write, and a silent background retry also makes
      // `error` a value that appears and disappears on a timer — impossible for a caller to
      // render honestly, and impossible for a test to observe without racing it. Failure is
      // therefore terminal and visible, and the "Load more" control becomes the retry.
      shouldRetryOnError: false,
    },
  );

  const subTasks = useMemo(() => (pages ?? []).flatMap((p) => p.tasks), [pages]);
  // Memoized for the same reason as subTasks: `?? []` mints a new array every render, and a
  // caller that puts this in a dependency array (a nested renderer resolving status labels is
  // the obvious one) would re-run on every parent render forever.
  const statusConfigs = useMemo(() => pages?.[0]?.statusConfigs ?? [], [pages]);

  const hasMore = getSubTasksHasMore(pages);
  // Stable identity, so a memoized row that takes this as a prop is not re-rendered by every
  // parent render. Functional `setSize` because two clicks in the same tick both read the same
  // stale `size` otherwise, and the second writes the value the first already wrote.
  const loadMore = useCallback(() => setSize((currentSize) => currentSize + 1), [setSize]);
  const retry = useCallback(() => { void mutate(); }, [mutate]);
  // SWR types its error as `any`, so asserting `as Error` here would be a claim this code
  // cannot make — a fetcher can reject with anything. Normalize instead, so a caller reading
  // `.message` always gets a string rather than `undefined` from a thrown non-Error.
  const normalizedError = error === undefined || error === null
    ? undefined
    : error instanceof Error ? error : new Error(String(error));

  return {
    subTasks,
    statusConfigs,
    hasMore,
    // With the gate shut there is no key, so SWR reports neither loading nor data —
    // report "not loading" rather than leaving a caller spinning forever.
    isLoading: gateOpen && isLoading,
    // A "Load more" click bumps `size` past 1 before the new page resolves into
    // `pages`. `size > 1` keeps the initial load out of this — that one is `isLoading`.
    //
    // The other two terms both exist to stop this latching on, because `pages` catching up
    // to `size` is not the only way a load ends:
    //   - `hasMore`: once the loaded pages end in hasMore: false, the key function returns
    //     null for every further index, so `pages` can never reach an inflated `size`.
    //   - `!normalizedError`: a later page that REJECTS also leaves `pages` short forever —
    //     retries are off, so nothing is in flight — while `hasMore` still reads true from
    //     the last page that did load. Reporting "loading more" there would disable the very
    //     control that retries it, under an error message saying it failed.
    // While a page genuinely is in flight, neither term fires: the last LOADED page still
    // says hasMore and no error is standing.
    isLoadingMore: gateOpen && size > 1 && hasMore && !normalizedError
      && (pages === undefined || pages.length < size),
    error: normalizedError,
    loadMore,
    retry,
  };
}
