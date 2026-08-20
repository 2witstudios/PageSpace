'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TableCell, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { post, del } from '@/lib/auth/auth-fetch';
import { useTaskWriter } from '@/lib/tasks/task-write-machinery';
import { taskWriteErrorMessage } from '@/lib/tasks/task-write-errors';
import {
  appendTaskToPages,
  applySubTaskCountsToPages,
  removeTaskFromPages,
  taskFromCreateResponse,
  resolveToggleStatus,
  blockedByOpenSubTasks,
  blockedStatusTransition,
  subTasksBlockedMessage,
} from '@/lib/tasks/task-cache-core';
import {
  type TaskItem,
  type TaskStatusConfig,
  type LocatedTaskHandlers,
  isCompletedStatus,
} from './task-list-types';
import { TASK_TABLE_COLUMN_COUNT } from './table-columns';
import {
  canAddSubTaskAt,
  canExpandNode,
  depthIndentStyle,
  isNodeExpanded,
  makeNodePath,
  resolveNodeStatusConfigs,
  type TaskNodePath,
} from './task-tree-core';
import { useTaskTree } from './task-tree-context';
import { useEditingSession } from '@/stores/useEditingSession';
import { TaskRowCells } from './TaskRowCells';
import { TaskDocumentRow } from './TaskDocumentRow';
import { useTaskSubTasks } from './useTaskSubTasks';

/**
 * Nested task rows, rendered as SIBLING `<tr>`s in the same `<tbody>`.
 *
 * Not inside the expansion cell: a table nested in a colspan cell cannot align
 * its columns with the parent's, and it reads as a different table bolted
 * underneath. Column alignment across levels is most of why this pattern feels
 * like a tree at all.
 *
 * `<tbody>` accepts only `<tr>` children. Fragments emit no DOM, so a component
 * returning `<>{tr}{tr}</>` is valid — a wrapper `<div>` is not, and neither is
 * a bare text node (React tolerates one client-side, but SSR and hydration
 * diverge). Depth is padding on the title cell's inner element, never on the
 * `<tr>`, where padding is not rendered.
 *
 * The shape is component recursion rather than one flattened list because a
 * hook cannot be called at variable depth: each EXPANDED node needs its own
 * `useTaskSubTasks`. TaskSubTaskRows is split out from TaskRowGroup so that a
 * COLLAPSED row mounts no hook at all — otherwise a hundred-row list would hold
 * a hundred idle useSWRInfinite instances.
 */

/** How a row tells whoever owns its cache that its sub-task counters moved. */
export type CountDelta = (delta: { total?: number; completed?: number }) => void;

export interface TaskRowGroupProps {
  task: TaskItem;
  depth: number;
  /** The page of the list this task belongs to — where its writes are addressed. */
  listPageId: string;
  path: TaskNodePath;
  /** Writers bound to the cache that holds THIS row. */
  handlers: LocatedTaskHandlers;
  /** Vocabulary this row's status dropdown may safely offer. */
  statusConfigs: TaskStatusConfig[];
  /** Adjusts this row's own counters in the cache that holds it. */
  onCountDelta?: CountDelta;
  /**
   * Which sibling this is, and how many there are. Omitted at depth 0, where
   * the list is paginated and any number would be a claim about rows that are
   * not loaded, and omitted for a sub-list with more pages to come.
   */
  posInSet?: number;
  setSize?: number;
  /**
   * Wraps the row at depth 0, where it has to carry dnd-kit's sortable ref and
   * the context menu. Nested rows render a plain row.
   *
   * Receives the tree state as well as the cells: the depth-0 row is the one
   * users expand most, and its wrapper has to put `aria-expanded` on the same
   * `<tr>` it renders — the treegrid role is worthless on a row that never
   * announces whether it is open.
   */
  renderRow?: (
    children: React.ReactNode,
    tree: { expandable: boolean; isExpanded: boolean },
  ) => React.ReactNode;
}

export function TaskRowGroup({
  task, depth, listPageId, path, handlers, statusConfigs, onCountDelta, renderRow,
  posInSet, setSize,
}: TaskRowGroupProps) {
  const { expandedPaths, canEdit } = useTaskTree();
  const isExpanded = isNodeExpanded(expandedPaths, path);
  const expandable = canExpandNode(task, depth);
  const hasSubTasks = (task.subTaskCount ?? 0) > 0;

  // A leaf has no chevron and therefore nowhere to put an inline "+ sub-task"
  // row, so the menu is the only way in. See useSubTaskBootstrap.
  const bootstrapSubTask = useSubTaskBootstrap({
    task, path, onCountDelta,
    // The menu creates a child one level below this row.
    enabled: canEdit && !!task.pageId && !hasSubTasks && canAddSubTaskAt(depth + 1),
  });

  const cells = (
    <TaskRowCells
      task={task}
      depth={depth}
      listPageId={listPageId}
      path={path}
      isExpanded={isExpanded}
      statusConfigs={statusConfigs}
      handlers={handlers}
      onAddSubTask={bootstrapSubTask}
    />
  );

  return (
    <>
      {renderRow ? renderRow(cells, { expandable, isExpanded }) : (
        <NestedTaskRow
          task={task} depth={depth} path={path}
          isExpanded={isExpanded} expandable={expandable}
          posInSet={posInSet} setSize={setSize}
        >
          {cells}
        </NestedTaskRow>
      )}
      {isExpanded && task.hasContent && <TaskDocumentRow task={task} depth={depth} />}
      {/*
        * Not gated on hasSubTasks. It was, and deleting the last sub-task then
        * unmounted this whole block — taking the inline "+ Add a sub-task…" row
        * with it, mid-flow, in the commonest clear-out-and-re-add workflow. The
        * network stays gated where it belongs: shouldFetchSubTasks returns
        * false at a count of 0, so an expanded leaf still issues no request.
        */}
      {isExpanded && task.pageId && (
        <TaskSubTaskRows
          task={task}
          parentDepth={depth}
          parentPath={path}
          onParentCountDelta={onCountDelta}
        />
      )}
    </>
  );
}

/**
 * How many extra pages the reveal walk will request. Bounded because the walk
 * exists to surface ONE created row: an unbounded one pages a very long
 * sub-list all the way out, and past this the row is a single "Load more" away
 * with a button already saying so.
 */
const MAX_REVEAL_PAGES = 5;

/**
 * A nested row. Deliberately NOT sortable: cross-level drag is a re-parenting
 * problem, not a reorder, and every expansion is collapsed before a drag begins
 * anyway.
 */
function NestedTaskRow({
  task, depth, path, isExpanded, expandable, posInSet, setSize, children,
}: {
  task: TaskItem;
  depth: number;
  path: TaskNodePath;
  isExpanded: boolean;
  expandable: boolean;
  posInSet?: number;
  setSize?: number;
  children: React.ReactNode;
}) {
  return (
    <TableRow
      // `data-task-path`, not `data-task-id`: Find queries `[data-task-id]` over
      // the top-level list only, and a nested row answering that query would
      // hand it matches its index cannot address.
      data-task-path={path}
      aria-level={depth + 1}
      // Sibling rows are flat <tr>s with no `role="group"` between them — a
      // tbody may not contain one — so aria-level alone says how deep this row
      // is and nothing about which sibling it is or how many there are.
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={expandable ? isExpanded : undefined}
      className={task.completedAt ? 'opacity-60' : undefined}
    >
      {/* Empty drag-handle cell keeps nested columns aligned with the parent's. */}
      <TableCell className="w-8 px-2" />
      {children}
    </TableRow>
  );
}

function TaskSubTaskRows({
  task, parentDepth, parentPath, onParentCountDelta,
}: {
  task: TaskItem;
  parentDepth: number;
  parentPath: TaskNodePath;
  onParentCountDelta?: CountDelta;
}) {
  const tree = useTaskTree();
  const {
    subTasks, statusConfigs, hasMore, canAppendCreated,
    isLoading, isLoadingMore, loadMore, retry, error, mutatePages,
  } = useTaskSubTasks(task);

  const listPageId = task.pageId!;
  /** Depth of the CHILDREN listed here — and of anything the inline row creates. */
  const childDepth = parentDepth + 1;

  // Root vocabulary when this sub-list defines every one of its slugs; its own
  // otherwise, because PATCH validates against THIS list's configs and a slug it
  // does not define comes back 400. New sub-lists inherit at seed time, so for
  // anything created since that landed the two sets are identical.
  const nodeStatusConfigs = useMemo(
    () => resolveNodeStatusConfigs(tree.rootStatusConfigs, statusConfigs) as TaskStatusConfig[],
    [tree.rootStatusConfigs, statusConfigs],
  );

  const { writeTaskField } = useTaskWriter({
    mutatePages,
    // Passed explicitly rather than read from a provider: TaskListView owns the
    // machinery (its socket effect needs it) and hands it down on the tree
    // context, so there is no second provider in the tree to read from.
    machinery: tree.writeMachinery,
    // Nothing revalidates in this cache by design, so a conflict is resolved by
    // re-requesting the pages already loaded.
    onRevisionConflict: retry,
    // ...and for the same reason, a deferred foreign echo has to reach this
    // cache explicitly: the machinery's revalidation refreshes the ROOT list.
    refreshOwnCache: retry,
  });

  const patchCounts = useCallback((childId: string, delta: { total?: number; completed?: number }) => {
    void mutatePages(
      (current) => applySubTaskCountsToPages(current, childId, delta),
      { revalidate: false },
    );
  }, [mutatePages]);

  const handlers = useMemo<LocatedTaskHandlers>(() => ({
    onToggleComplete: async (loc, child) => {
      if (!tree.canEdit) return;
      const isDone = isCompletedStatus(child.status, nodeStatusConfigs);
      if (!isDone) {
        const blocked = blockedByOpenSubTasks(child);
        if (blocked) {
          toast.error(subTasksBlockedMessage(blocked));
          return;
        }
      }
      const next = resolveToggleStatus(nodeStatusConfigs, isDone);
      const ok = await writeTaskField({
        loc,
        body: { status: next },
        optimistic: {
          status: next,
          completedAt: isDone ? null : new Date().toISOString(),
        },
        fallbackMessage: 'Failed to update status',
      });
      // Counters live on the PARENT row, in the cache one level up. Only the
      // direct parent changes — the server groups them on pages.parentId, so
      // there is no bubbling further than this.
      //
      // The delta is derived from the status GROUP while the server counts
      // `completedAt IS NOT NULL`. Those agree because PATCH stamps completedAt
      // on exactly the done-group transitions (tasks/[taskId]/route.ts) — a real
      // coupling, not a coincidence, and the reason a status change that stops
      // stamping would silently drift these numbers.
      if (ok) onParentCountDelta?.({ completed: isDone ? -1 : 1 });
    },
    onStatusChange: async (loc, child, status) => {
      if (!tree.canEdit) return;
      // The dropdown can select a done status directly — same completion the
      // checkbox performs, so the same guard applies.
      const blocked = blockedStatusTransition(child, status, nodeStatusConfigs);
      if (blocked) {
        toast.error(subTasksBlockedMessage(blocked));
        return;
      }
      const wasDone = isCompletedStatus(child.status, nodeStatusConfigs);
      const nowDone = isCompletedStatus(status, nodeStatusConfigs);
      const ok = await writeTaskField({
        loc,
        body: { status },
        optimistic: { status, completedAt: nowDone ? new Date().toISOString() : null },
        fallbackMessage: 'Failed to update status',
      });
      if (ok && wasDone !== nowDone) onParentCountDelta?.({ completed: nowDone ? 1 : -1 });
    },
    onPriorityChange: (loc, priority) => {
      if (!tree.canEdit) return;
      void writeTaskField({
        loc,
        body: { priority },
        optimistic: { priority: priority as TaskItem['priority'] },
        fallbackMessage: 'Failed to update priority',
      });
    },
    onAssigneeChange: (loc, assigneeId, agentId) => {
      if (!tree.canEdit) return;
      void writeTaskField({
        loc,
        body: { assigneeId, assigneeAgentId: agentId },
        optimistic: {},
        fallbackMessage: 'Failed to update assignee',
      });
    },
    onMultiAssigneeChange: (loc, assigneeIds) => {
      if (!tree.canEdit) return;
      void writeTaskField({
        loc, body: { assigneeIds }, optimistic: {},
        fallbackMessage: 'Failed to update assignees',
      });
    },
    onDueDateChange: (loc, date) => {
      if (!tree.canEdit) return;
      const iso = date?.toISOString() ?? null;
      void writeTaskField({
        loc, body: { dueDate: iso }, optimistic: { dueDate: iso },
        fallbackMessage: 'Failed to update due date',
      });
    },
    onSaveTitle: (loc, title) => {
      void writeTaskField({
        loc, body: { title }, optimistic: { title },
        fallbackMessage: 'Failed to update task',
      });
    },
    onDelete: async (loc) => {
      if (!tree.canEdit) return;
      const child = subTasks.find((t) => t.id === loc.taskId);
      const wasDone = child ? isCompletedStatus(child.status, nodeStatusConfigs) : false;
      try {
        await del(`/api/pages/${loc.listPageId}/tasks/${loc.taskId}`);
        void mutatePages((c) => removeTaskFromPages(c, loc.taskId), { revalidate: false });
        onParentCountDelta?.({ total: -1, completed: wasDone ? -1 : 0 });
        toast.success('Task deleted');
      } catch (e) {
        toast.error(taskWriteErrorMessage(e, 'Failed to delete task'));
        retry();
      }
    },
    onNavigate: tree.onNavigate,
    onStartEdit: tree.onStartEdit,
    onConfigureTriggers: (child) => tree.openTriggerDialog(child, listPageId),
  }), [
    tree, nodeStatusConfigs, writeTaskField, subTasks, mutatePages, retry,
    onParentCountDelta, listPageId,
  ]);

  /**
   * Set when a created task landed on a page this cache has not loaded, so the
   * window has to be widened until it comes into view.
   *
   * A refetch alone cannot do it: `retry` re-requests the pages already loaded,
   * and a new task is at the END of the server's ordering — i.e. in a page that
   * is not one of them. The row simply never appeared, while the input cleared
   * and the parent's badge went up, which reads as "it didn't save" and invites
   * the user to type it again. Only reachable on a sub-list past its first page
   * of 100, where the inline add row sits directly above "Load more".
   */
  const [revealCreated, setRevealCreated] = useState(0);
  useEffect(() => {
    if (revealCreated === 0) return;
    // Stop on anything that means "no more progress will be made". Without the
    // error arm this spins: a failed page leaves `isLoadingMore` false (the hook
    // forces it so) while `hasMore` still reads true off the last page that DID
    // load, so the effect re-fires and re-requests, at ~20 req/s, against a
    // route that lazily WRITES — the exact opposite of the hook's
    // shouldRetryOnError: false.
    if (!hasMore || error) { setRevealCreated(0); return; }
    // And a bound even when everything succeeds: the new task is at the end of
    // the ordering, so an unbounded walk would page a 2,000-sub-task list all
    // the way out — twenty sequential requests and two thousand rows — because
    // somebody added one item. Past this, the row is one "Load more" away and
    // the button says so, which is a better answer than a stampede.
    if (revealCreated > MAX_REVEAL_PAGES) { setRevealCreated(0); return; }
    if (!isLoadingMore) {
      setRevealCreated((n) => n + 1);
      loadMore();
    }
  }, [revealCreated, hasMore, error, isLoadingMore, loadMore]);

  const addCreatedChild = useCallback((created: TaskItem) => {
    // Decided out here rather than inside the updater, which is contractually
    // pure and was being made to call retry() and setState — re-entering mutate
    // on the key mutate was already running against.
    //
    // `canAppendCreated`, not `!hasMore`. They differ exactly where it matters:
    // with no pages loaded at all — a first page that failed, or one still in
    // flight — `hasMore` is false while there is nothing to append TO, and the
    // append silently no-ops. That is the case that most needs the refetch.
    if (!canAppendCreated) {
      // Later pages are still unloaded, so the end of the server's ordering is
      // not the end of what we have. Refresh what we hold, then walk the window
      // out to the new task rather than render it in a slot it does not occupy.
      retry();
      setRevealCreated(1);
    } else {
      void mutatePages((current) => appendTaskToPages(current, created), { revalidate: false });
    }
    // Not always `{ total: 1 }`. POST seeds the status from the list's own
    // vocabulary, and a list with no open status resolves to a done one — which
    // the server then stamps complete. Counting that as an open sub-task leaves
    // the parent reading n/(n+1) forever: the guard refuses to complete it, and
    // this cache has no revalidation trigger to correct the number.
    onParentCountDelta?.({ total: 1, completed: created.completedAt ? 1 : 0 });
  }, [canAppendCreated, mutatePages, retry, onParentCountDelta]);

  return (
    <>
      {isLoading && (
        <AffordanceRow depth={childDepth}>
          <Skeleton className="h-6 w-48" />
        </AffordanceRow>
      )}

      {subTasks.map((child, index) => (
        <TaskRowGroup
          key={child.id}
          task={child}
          depth={childDepth}
          posInSet={index + 1}
          // Only what is loaded: with `hasMore` still true this understates the
          // set, and saying "3 of 3" while a Load more row sits below would be
          // worse than saying nothing.
          setSize={hasMore ? undefined : subTasks.length}
          listPageId={listPageId}
          path={makeNodePath(parentPath, child.id)}
          handlers={handlers}
          statusConfigs={nodeStatusConfigs}
          onCountDelta={(delta) => patchCounts(child.id, delta)}
        />
      ))}

      {tree.canEdit && canAddSubTaskAt(childDepth) && (
        <NewSubTaskRow listPageId={listPageId} depth={childDepth} onCreated={addCreatedChild} />
      )}

      {/* An expansion that shows nothing has to say why — it was expandable
          because a count said there was something here. Gated on that count:
          a row is also expandable for having a DESCRIPTION, and telling someone
          their sub-tasks are "no longer here" when they never had any is a
          statement about nothing. */}
      {!isLoading && (error || (subTasks.length === 0 && (task.subTaskCount ?? 0) > 0)) && (
        <AffordanceRow depth={childDepth}>
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground italic">
            {error
              ? (subTasks.length > 0 ? 'Could not load the rest of the sub-tasks.' : 'Could not load sub-tasks.')
              : 'These sub-tasks are no longer here.'}
          </p>
        </AffordanceRow>
      )}

      {/* Shown on `error` even with nothing more to load: a FIRST page that
          failed leaves hasMore false, and nothing retries on its own, so a
          missing control there would be a dead end. Which recovery to offer
          depends on which page failed, and the difference is requests against a
          route that writes — `retry` re-issues every loaded page, while paging
          forward requests only the one that is missing. */}
      {(hasMore || error) && (
        <AffordanceRow depth={childDepth}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs text-muted-foreground"
            disabled={isLoadingMore}
            onClick={error && subTasks.length === 0 ? retry : loadMore}
          >
            {isLoadingMore ? 'Loading…' : error ? 'Try again' : 'Load more sub-tasks'}
          </Button>
        </AffordanceRow>
      )}
    </>
  );
}

/**
 * A non-task row inside the tree — loading, error, "load more", the inline add
 * row. It carries aria-level for the same reason the task rows do: without it a
 * row sitting inside a level-2 subtree is announced as a peer of the top-level
 * rows.
 */
function AffordanceRow({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <tr aria-level={depth + 1}>
      <td colSpan={TASK_TABLE_COLUMN_COUNT} className="px-4 py-1 border-b bg-muted/10">
        <div style={depthIndentStyle(depth)}>{children}</div>
      </td>
    </tr>
  );
}

/**
 * The inline "+ sub-task" row. This is what removes the screen jump: creating a
 * sub-task previously required navigating into the parent task first.
 */
function NewSubTaskRow({
  listPageId, depth, onCreated,
}: {
  listPageId: string;
  depth: number;
  onCreated: (task: TaskItem) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * Registered while a title is pending or a create is in flight.
   *
   * Not for the usual reason. SWR cannot clobber `title` — it is local state,
   * and this row's own cache (useTaskSubTasks) has every revalidation trigger
   * switched off. The real loss mode is a REMOUNT: this component only exists
   * while its ancestor row is rendered and expanded, so a ROOT-list
   * revalidation — a socket task_added/task_deleted, the 5-minute interval, a
   * filter change — that re-paginates or removes that ancestor unmounts the
   * whole subtree and takes the half-typed title with it. `isAnyEditing` pauses
   * exactly that revalidation, which is why the registration has to start at
   * the first character and not at submit.
   *
   * It is not free: the same flag disables the root list's "Load More" with
   * "Finish editing to load more" and defers auth refresh. That is the standing
   * trade this app already makes for every other editor, and losing typed text
   * is the worse outcome.
   *
   * The id is per-instance: several of these exist at once, one per expanded
   * node, and a shared key would have the first to finish end them all.
   */
  const instanceId = useId();
  useEditingSession(
    `new-subtask-${listPageId}-${instanceId}`,
    title.trim().length > 0 || busy,
    'form',
    { componentName: 'NewSubTaskRow', pageId: listPageId },
  );

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const created = await post<TaskItem>(`/api/pages/${listPageId}/tasks`, { title: trimmed });
      setTitle('');
      // The create route omits the derived fields the list route computes, so
      // normalize before the row goes into a cache that will read them.
      onCreated(taskFromCreateResponse(created));
    } catch (e) {
      toast.error(taskWriteErrorMessage(e, 'Failed to create sub-task'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr aria-level={depth + 1}>
      <td colSpan={TASK_TABLE_COLUMN_COUNT} className="px-4 py-1 border-b bg-muted/10">
        <div style={depthIndentStyle(depth)}>
          <Input
            placeholder="+ Add a sub-task…"
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            className="h-7 border-0 shadow-none focus-visible:ring-0 px-0 text-sm"
          />
        </div>
      </td>
    </tr>
  );
}

/**
 * "Add sub-task" for a row that has none yet.
 *
 * The gate chain is why this needs its own path: `canExpandNode` wants
 * `hasContent || subTaskCount > 0` before it shows a chevron, and
 * `shouldFetchSubTasks` wants `subTaskCount > 0` before it will fetch. A leaf
 * satisfies neither, so there is no expansion to host an inline row. Creating
 * through the menu bumps the count in the cache — which opens both gates — and
 * expands the row, after which the normal inline flow takes over.
 */
function useSubTaskBootstrap({
  task, path, onCountDelta, enabled,
}: {
  task: TaskItem;
  path: TaskNodePath;
  onCountDelta?: CountDelta;
  enabled: boolean;
}): (() => void) | undefined {
  const { toggleExpanded, expandedPaths } = useTaskTree();

  const run = useCallback(async () => {
    if (!task.pageId) return;
    try {
      const created = await post<TaskItem>(`/api/pages/${task.pageId}/tasks`, { title: 'New sub-task' });
      // Same rule as addCreatedChild: a done-seeded task arrives already
      // complete, and counting it as open blocks the parent.
      onCountDelta?.({ total: 1, completed: created.completedAt ? 1 : 0 });
      if (!isNodeExpanded(expandedPaths, path)) toggleExpanded(path);
    } catch (e) {
      toast.error(taskWriteErrorMessage(e, 'Failed to create sub-task'));
    }
  }, [task.pageId, onCountDelta, expandedPaths, path, toggleExpanded]);

  if (!enabled) return undefined;
  return () => { void run(); };
}
