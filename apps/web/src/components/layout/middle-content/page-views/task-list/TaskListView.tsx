'use client';

/**
 * Pane-safe by design: layout-mode decisions (card vs. table, toolbar wrap)
 * use `@container` + `@[Npx]:` variants keyed to this view's own rendered
 * width, not viewport (`sm:`/`md:`/`lg:`) breakpoints — a pane can be narrow
 * at any viewport width. Follow this pattern for any other page-view
 * component that needs to reflow inside a resizable pane.
 */

import { useState, useEffect, useId, useRef, useCallback, memo, useMemo } from 'react';
import { type Editor } from '@tiptap/react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import useSWRInfinite from 'swr/infinite';
import { mutate as globalMutate } from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions, canManageDrive } from '@/hooks/usePermissions';
import { useDriveStore } from '@/hooks/useDrive';
import { useEditingStore } from '@/stores/useEditingStore';
import { useFindStore } from '@/stores/useFindStore';
import { useEditingSession } from '@/stores/useEditingSession';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useTaskListPageFilter } from './useTaskListPageFilter';
import { TreePage } from '@/hooks/usePageTree';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import { useSocketStore } from '@/stores/useSocketStore';
import type { TaskEventPayload } from '@/lib/websocket/socket-utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  GripVertical,
  Zap,
  Bell,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { MultiAssigneeSelect } from './MultiAssigneeSelect';
import { DueDatePicker } from './DueDatePicker';
import { TaskKanbanView } from './TaskKanbanView';
import { TaskListDescriptionContent } from './TaskListDescription';
import { TaskListHeader } from './TaskListHeader';
import { selfTaskKey } from './useSelfTask';
import Toolbar from '@/components/editors/Toolbar';
import { TASK_TABLE_COLUMN_COUNT } from './table-columns';
import { TaskRowGroup } from './TaskRowGroup';
import { TaskTreeProvider } from './task-tree-context';
import {
  formatSubTaskProgress,
  makeNodePath,
  rootNodePath,
  toggleNodePath,
  expandNodePath,
  type TaskNodePath,
} from './task-tree-core';
import { StatusConfigManager } from './StatusConfigManager';
import { TaskAgentTriggersDialog } from './TaskAgentTriggersDialog';
import { TaskListWorkflowsDialog } from './TaskListWorkflowsDialog';
import {
  TaskItem,
  TaskListData,
  TaskStatusConfig,
  TaskLocation,
  LocatedTaskHandlers,
  bindTaskHandlersToList,
  buildStatusConfig,
  getStatusOrder,
  isCompletedStatus,
  PRIORITY_CONFIG,
} from './task-list-types';
import {
  resolveToggleStatus,
  blockedByOpenSubTasks,
  blockedStatusTransition,
  subTasksBlockedMessage,
  applySubTaskCountsToPages,
} from '@/lib/tasks/task-cache-core';
import { useTaskWriteMachinery, useTaskWriter } from '@/lib/tasks/task-write-machinery';

interface TaskListViewProps {
  page: TreePage;
}

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

// Matches DEFAULT_LIMIT in the GET route's query-spec.ts; must stay <= that route's
// MAX_LIMIT (200) or every "Load More" page would silently get clamped down server-side.
const TASKS_PAGE_SIZE = 100;

// Mobile task card component
interface MobileTaskCardProps {
  task: TaskItem;
  canEdit: boolean;
  onToggleComplete: (task: TaskItem) => void;
  onStatusChange: (task: TaskItem, status: string) => void;
  onPriorityChange: (taskId: string, priority: string) => void;
  onMultiAssigneeChange: (taskId: string, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  onDueDateChange: (taskId: string, date: Date | null) => void;
  onSaveTitle: (taskId: string, title: string) => void;
  onDelete: (taskId: string) => void;
  onNavigate: (task: TaskItem) => void;
  onConfigureTriggers?: (task: TaskItem) => void;
  driveId: string;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onStartEdit: (task: TaskItem) => void;
  onCancelEdit: () => void;
  statusConfigMap: Record<string, { label: string; color: string }>;
  statusOrder: string[];
  statusConfigs: TaskStatusConfig[];
}

function MobileTaskCard({
  task,
  canEdit,
  onToggleComplete,
  onStatusChange,
  onPriorityChange,
  onMultiAssigneeChange,
  onDueDateChange,
  onSaveTitle,
  onDelete,
  onNavigate,
  onConfigureTriggers,
  driveId,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onStartEdit,
  onCancelEdit,
  statusConfigMap,
  statusOrder,
  statusConfigs,
}: MobileTaskCardProps) {
  const isCompleted = isCompletedStatus(task.status, statusConfigs);
  const subTaskProgress = formatSubTaskProgress(task);

  return (
    <div
      className={cn(
        'border rounded-lg p-4 bg-card',
        isCompleted && 'opacity-60'
      )}
    >
      {/* Header: Checkbox + Title + Actions */}
      <div className="flex items-start gap-3">
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => onToggleComplete(task)}
          disabled={!canEdit}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <Input
              value={editingTitle}
              onChange={(e) => onEditingTitleChange(e.target.value)}
              onBlur={() => {
                if (editingTitle.trim()) {
                  onSaveTitle(task.id, editingTitle.trim());
                }
                onCancelEdit();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
                if (e.key === 'Escape') onCancelEdit();
              }}
              autoFocus
              className="h-8"
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={cn(
                  'font-medium cursor-pointer hover:text-primary bg-transparent border-0 p-0 text-left',
                  isCompleted && 'line-through text-muted-foreground'
                )}
                onClick={() => onNavigate(task)}
              >
                {task.title}
              </button>
              {/* Sub-task progress — parity with the table and kanban. */}
              {subTaskProgress && (
                <span
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  title={`${subTaskProgress.label} sub-tasks complete`}
                >
                  {/* See TaskKanbanView: an aria-label on a generic span is
                      discarded, so the sentence is sr-only text. */}
                  <span aria-hidden="true">{subTaskProgress.label}</span>
                  <span className="sr-only">{`${subTaskProgress.label} sub-tasks complete`}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {task.pageId && (
              <DropdownMenuItem onClick={() => onNavigate(task)}>
                <FileText className="h-4 w-4 mr-2" />
                Open
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onStartEdit(task)} disabled={!canEdit}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
            {onConfigureTriggers && (
              <DropdownMenuItem onClick={() => onConfigureTriggers(task)} disabled={!canEdit}>
                <Zap className="h-4 w-4 mr-2" />
                Agent triggers…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onDelete(task.id)}
              className="text-destructive"
              disabled={!canEdit}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Metadata row */}
      <div className="flex flex-wrap items-center gap-2 mt-3 pl-7">
        {/* Status - uses dynamic status configs */}
        <Select
          value={task.status}
          onValueChange={(value) => onStatusChange(task, value)}
          disabled={!canEdit}
        >
          <SelectTrigger className="h-7 w-auto px-2">
            <SelectValue>
              <Badge className={cn('text-xs', statusConfigMap[task.status]?.color || 'bg-slate-100 text-slate-700')}>
                {statusConfigMap[task.status]?.label || task.status}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {statusOrder.map(slug => {
              const cfg = statusConfigMap[slug];
              if (!cfg) return null;
              return (
                <SelectItem key={slug} value={slug}>
                  <Badge className={cn('text-xs', cfg.color)}>{cfg.label}</Badge>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        {/* Priority */}
        <Select
          value={task.priority}
          onValueChange={(value) => onPriorityChange(task.id, value)}
          disabled={!canEdit}
        >
          <SelectTrigger className="h-7 w-auto px-2">
            <SelectValue>
              <Badge className={cn('text-xs', PRIORITY_CONFIG[task.priority].color)}>
                {PRIORITY_CONFIG[task.priority].label}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PRIORITY_CONFIG).map(([key, { label, color }]) => (
              <SelectItem key={key} value={key}>
                <Badge className={cn('text-xs', color)}>{label}</Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Multiple Assignees */}
        <MultiAssigneeSelect
          driveId={driveId}
          assignees={task.assignees || []}
          onUpdate={(assigneeIds) => onMultiAssigneeChange(task.id, assigneeIds)}
          disabled={!canEdit}
        />

        {canEdit && onConfigureTriggers && (task.activeTriggerCount ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => onConfigureTriggers(task)}
            title="Agent trigger configured — click to edit"
            aria-label="Agent trigger configured — click to edit"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300/60 bg-amber-50 px-2 text-xs text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300"
          >
            <Bell className="h-3 w-3" />
            <span>Trigger</span>
          </button>
        )}

        {/* Due Date */}
        <DueDatePicker
          currentDate={task.dueDate}
          onSelect={(date) => onDueDateChange(task.id, date)}
          disabled={!canEdit}
        />
      </div>
    </div>
  );
}

/**
 * The collapsed state, shared. Minting `new Set()` per call is a new reference
 * every time, so setting it re-renders the whole tree even when nothing was
 * open — which the filter effect does on every keystroke.
 */
const EMPTY_EXPANDED: Set<TaskNodePath> = new Set();

// Only the most recently loaded page's hasMore matters — earlier pages are stale
// snapshots of a bound that may have shifted as tasks were added/removed since.
export const getHasMoreTasks = (pages: { hasMore: boolean }[] | undefined): boolean => {
  if (!pages || pages.length === 0) return false;
  return pages[pages.length - 1].hasMore;
};

// True while a "Load More" click has bumped useSWRInfinite's `size` but the newly
// requested page hasn't resolved into `pages` yet.
export const isLoadingNextTaskPage = (pages: { hasMore: boolean }[] | undefined, size: number): boolean =>
  size > 0 && (pages === undefined || pages.length < size);

export type TaskLoadMoreState = 'idle' | 'loading' | 'failed';

// A requested page hasn't resolved into `pages` yet — true both while it's still in
// flight and after it's permanently failed, since SWR keeps the last-good `data` and
// sets `error` alongside it rather than clearing it. Disambiguates those two so the
// "Load More" control can show a spinner vs. a retry state instead of getting stuck.
export const getTaskLoadMoreState = (
  pages: { hasMore: boolean }[] | undefined,
  size: number,
  hasError: boolean,
): TaskLoadMoreState => {
  // The last resolved page is authoritative over `size`: if the server says there's
  // nothing more, that holds even when `size` (how many "Load More" clicks the user
  // has made) is stale — e.g. concurrent deletes shrink the total across a page
  // boundary, getTasksPageKey starts returning null for the pages beyond it, and
  // `pages.length` permanently stops growing to match `size`. Without this check that
  // reads as "still loading" forever instead of "there's nothing left to load".
  if (getHasMoreTasks(pages) === false && pages && pages.length > 0) return 'idle';
  if (!isLoadingNextTaskPage(pages, size)) return 'idle';
  return hasError ? 'failed' : 'loading';
};

// `isPaused` (an app-wide "any document/form editing session" flag — see the config
// comment where it's set) gates every SWR revalidation for this hook, including this
// button's own click, not just background polling. There's no public SWR API to bypass
// it for one call, so instead of leaving the button clickable and silently doing
// nothing, disable it and say why while editing is active — the safe, honest fallback.
export const getLoadMoreButtonLabel = (
  loadMoreState: TaskLoadMoreState,
  isEditingElsewhere: boolean,
): string => {
  if (isEditingElsewhere) return 'Finish editing to load more';
  if (loadMoreState === 'loading') return 'Loading…';
  if (loadMoreState === 'failed') return 'Retry';
  return 'Load more tasks';
};

// Splits a reordered task list back into the same number of pages, each keeping its
// original size (and every other field, e.g. hasMore, untouched) — used for the
// drag-reorder optimistic update so getHasMoreTasks/isLoadingNextTaskPage stay correct
// through the optimistic window instead of collapsing every loaded page into one.
export const redistributeTasksAcrossPages = <P extends { tasks: TaskItem[] }>(
  pages: P[],
  reorderedTasks: TaskItem[],
): P[] => {
  let cursor = 0;
  return pages.map((p) => {
    const chunk = reorderedTasks.slice(cursor, cursor + p.tasks.length);
    cursor += p.tasks.length;
    return { ...p, tasks: chunk };
  });
};

/**
 * The top-level row: a sortable `<tr>` plus its context menu.
 *
 * It owns only the row now. Expansion content — the document and the nested
 * sub-task rows — is emitted by TaskRowGroup as SIBLING rows in the same
 * `<tbody>`, so the columns of a sub-task line up with its parent's instead of
 * living inside a colspan cell.
 */
interface SortableTaskRowProps {
  task: TaskItem;
  canEdit: boolean;
  isCompleted: boolean;
  /**
   * Which row this is and how many there are. Nested rows carry these, so
   * omitting them here would have a treegrid where children announce "3 of 5"
   * under a parent that announces no position at all.
   */
  posInSet: number;
  setSize?: number;
  /** Whether this row has anything to expand, and whether it currently is. */
  expandable: boolean;
  isExpanded: boolean;
  contextMenu?: React.ReactNode;
  children: React.ReactNode;
}

function SortableTaskRow({
  task, canEdit, isCompleted, expandable, isExpanded, posInSet, setSize, contextMenu, children,
}: SortableTaskRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const row = (
    <TableRow
      ref={setNodeRef}
      style={style}
      data-task-id={task.id}
      aria-level={1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      // Top-level rows are the ones most often expanded; without this the
      // treegrid announces a level and never says whether it is open.
      aria-expanded={expandable ? isExpanded : undefined}
      className={cn(
        isCompleted && 'opacity-60',
        isDragging && 'opacity-50 bg-muted'
      )}
    >
      {/* Drag handle */}
      <TableCell className="w-8 px-2">
        {canEdit && task.pageId && (
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
      </TableCell>
      {children}
    </TableRow>
  );

  if (!contextMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  );
}

function TaskListView({ page }: TaskListViewProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;
  const drive = useDriveStore((s) => s.drives.find((d) => d.id === page.driveId));
  const canManageWorkflows = canManageDrive(drive);
  const isAnyEditing = useEditingStore(state => state.isAnyEditing());

  const [filter, setFilter] = useTaskListPageFilter(page.id);
  const [search, setSearch] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Connect Cmd+F to existing search input
  const isFindOpen = useFindStore((s) => s.isOpen);
  const findQuery = useFindStore((s) => s.query);
  const findIndex = useFindStore((s) => s.currentIndex);
  const reportMatches = useFindStore((s) => s.reportMatches);

  useEffect(() => {
    if (isFindOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isFindOpen]);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  // Carries the list the task belongs to, not just the task: TaskAgentTriggersDialog
  // writes through /api/pages/{pageId}/tasks/... , and for a nested task that is its
  // parent task's page, not the viewed list's.
  const [triggerDialogTask, setTriggerDialogTask] =
    useState<{ task: TaskItem; listPageId: string } | null>(null);
  const openTriggerDialog = useCallback(
    (task: TaskItem, listPageId: string) => setTriggerDialogTask({ task, listPageId }),
    [],
  );
  const [workflowsDialogOpen, setWorkflowsDialogOpen] = useState(false);
  // Keyed by PATH (rootPageId/taskId/taskId…), not task id: it makes "collapse
  // this node's whole subtree" a prefix operation and gives React an
  // unambiguous key when the same task could appear in two places.
  const [expandedPaths, setExpandedPaths] = useState<Set<TaskNodePath>>(EMPTY_EXPANDED);
  const toggleExpanded = useCallback(
    (path: TaskNodePath) => setExpandedPaths(prev => toggleNodePath(prev, path)),
    [],
  );
  const expandNode = useCallback(
    // Not re-wrapped in `new Set`: expandNodePath returns the SAME set when the
    // node is already open, and React then skips the re-render — a wrapper here
    // would mint a new one every time and throw that away.
    (path: TaskNodePath) => setExpandedPaths(prev => expandNodePath(prev, path)),
    [],
  );
  const viewMode = useLayoutStore((state) => state.taskListViewMode);
  const setViewMode = useLayoutStore((state) => state.setTaskListViewMode);
  // Description is always collapsed on load; the user expands it via the header toggle.
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const hasLoadedRef = useRef(false);

  // Use centralized socket store for proper authentication
  const socket = useSocketStore((state) => state.socket);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);
  const connect = useSocketStore((state) => state.connect);

  // Drag-and-drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // instanceId distinguishes this mount from any other simultaneous mount of
  // the SAME page (main center panel vs. an agent-session pane) — without it,
  // both compute the identical `page.id` key and collide in useEditingStore's
  // Map (see DocumentView's identical fix).
  const instanceId = useId();
  useEditingSession(`${page.id}-${instanceId}`, !!editingTaskId, 'form', {
    pageId: page.id,
    componentName: 'TaskListView',
  });

  // Fetch tasks with refresh protection, paginated via useSWRInfinite (bounded route:
  // apps/web/src/app/api/pages/[pageId]/tasks/route.ts defaults to limit=100/offset=0).
  // CRITICAL: Only pause AFTER initial load - never block the first fetch
  const tasksKeyPrefix = `/api/pages/${page.id}/tasks`;
  const getTasksPageKey = (pageIndex: number, previousPageData: TaskListData | null) => {
    if (previousPageData && !previousPageData.hasMore) return null;
    return `${tasksKeyPrefix}?limit=${TASKS_PAGE_SIZE}&offset=${pageIndex * TASKS_PAGE_SIZE}`;
  };
  const {
    data: taskPages,
    error,
    isLoading,
    size,
    setSize,
    mutate: mutateTaskPages,
  } = useSWRInfinite<TaskListData>(
    getTasksPageKey,
    fetcher,
    {
      revalidateOnFocus: false,
      // swr/infinite's default (revalidateFirstPage: true, revalidateAll: false) only
      // ever refreshes page 0 on the interval tick below — pages 1+ only refetch when
      // an explicit mutate() targets them (verified against swr/infinite's source: a
      // page's own cache entry has to be missing or explicitly marked "revalidate all"
      // for it to refetch; time passing alone isn't enough once it's cached). Without
      // revalidateAll, a missed socket event for a task on page 2+ would stay stale
      // until the next explicit write anywhere in this list. The cost is that every
      // "Load More" click also refetches every already-loaded page, not just the new
      // one — acceptable for a background task list, and worth it for correctness.
      revalidateAll: true,
      // `isAnyEditing` is app-wide (any document/form edit anywhere, not just this
      // page — useEditingStore.ts), and SWR's isPaused() gates every revalidation for
      // this key, not just background ones — including this PR's "Load More"/Retry
      // clicks (verified in swr's core revalidate()). There's no public SWR API to
      // bypass isPaused for one call, so instead of a click that silently no-ops,
      // getLoadMoreButtonLabel + the disabled prop below surface it honestly: the
      // control disables with an explanation while any edit session is active, and
      // works normally again once it ends. This isPaused gate itself is a pre-existing
      // pattern, not new to pagination — every write handler in this file already had
      // the identical exposure through its own post-write mutate() call.
      isPaused: () => hasLoadedRef.current && isAnyEditing,
      onSuccess: () => { hasLoadedRef.current = true; },
      refreshInterval: 300000, // 5 minutes
    }
  );

  // useSWRInfinite's reactive cache entry lives under a synthetic `$inf$<firstPageKey>`
  // key, not under each page's own URL — a plain-string key matcher here would silently
  // touch dead cache entries and never actually revalidate. Only the hook's own bound
  // `mutate` (with no args, forcing every loaded page to refetch — see swr/infinite's
  // `_i` "revalidate all" flag) reaches the right key.
  const mutateTasks = useCallback(() => mutateTaskPages(), [mutateTaskPages]);

  const data: TaskListData | undefined = useMemo(() => {
    if (!taskPages || taskPages.length === 0) return undefined;
    return {
      taskList: taskPages[0].taskList,
      statusConfigs: taskPages[0].statusConfigs,
      tasks: taskPages.flatMap(p => p.tasks),
      hasMore: getHasMoreTasks(taskPages),
    };
  }, [taskPages]);
  const hasMoreTasks = data?.hasMore ?? false;
  const loadMoreState = getTaskLoadMoreState(taskPages, size, !!error);
  const isLoadingMoreTasks = loadMoreState === 'loading';
  const loadMoreFailed = loadMoreState === 'failed';
  const handleLoadMoreTasks = () => setSize(size + 1);

  // Stable ref so the page:moved handler always sees the current task list
  // regardless of when the socket effect was installed relative to the SWR load.
  const tasksRef = useRef(data?.tasks);
  useEffect(() => { tasksRef.current = data?.tasks; }, [data?.tasks]);

  // View-wide: the log of writes this tab made (so its own socket echoes can be
  // told apart from everyone else's — including the same account in another
  // tab), plus the queue of echoes that arrived too early to classify.
  const writeMachinery = useTaskWriteMachinery(user?.id, mutateTasks);

  /**
   * Task field writes that show their result before the network answers.
   *
   * This is what makes the checkbox feel instant. Previously every handler
   * awaited a PATCH — which itself awaits two outbound realtime HTTP posts —
   * and then called mutateTasks(), a revalidate-ALL that refetches every loaded
   * page; the socket echo then fired a second one. The row did not change until
   * all of that finished, and if any edit session was open anywhere in the app
   * the SWR `isPaused` gate made the post-write mutate a silent no-op, so the
   * checkbox never moved at all.
   */
  const { writeTaskField } = useTaskWriter({
    mutatePages: mutateTaskPages,
    onRevisionConflict: mutateTasks,
    machinery: writeMachinery,
  });

  // Connect to socket store when user is available
  useEffect(() => {
    if (!user) return;

    // Ensure socket is connected
    if (connectionStatus === 'disconnected') {
      connect();
    }
  }, [user, connectionStatus, connect]);

  // Socket connection for real-time updates
  useEffect(() => {
    if (!socket || connectionStatus !== 'connected') return;

    socket.emit('join_channel', page.id);

    // Handle task events (event names match backend broadcast format: task:${operation})
    //
    // These refetch the ROOT list only, and deliberately: expanded nodes own
    // caches of their own that this does not touch. Fanning out to them was
    // tried and reverted — broadcastTaskEvent posts to `user:<actor>:tasks` and
    // to `payload.pageId`, which for a nested write is the PARENT TASK's page,
    // not this view's. So a foreign edit inside an open node never arrives here
    // at all (the F4 gap; nested realtime is filed as follow-up work), while
    // `task_added`/`deleted`/`reordered` carry no self-echo filter — meaning
    // the fan-out would have fired one extra GET per expanded node on the
    // user's OWN every write, each one lazily seeding task_lists rows, and
    // served no foreign case in exchange.
    const handleTaskAdded = () => {
      mutateTasks();
    };

    // A task update is only worth a full revalidate-all if somebody ELSE made it.
    // Our own write already patched the cache; refetching on the echo would undo
    // the whole point of the optimistic update.
    const handleTaskUpdated = (payload: TaskEventPayload) => {
      if (writeMachinery.shouldRevalidateForEvent(payload)) mutateTasks();
    };

    const handleTaskDeleted = () => {
      mutateTasks();
    };

    const handleTasksReordered = () => {
      mutateTasks();
    };

    // Handle tasks moved between lists via drag-and-drop. The reorder API emits
    // page:moved on the drive room (joined by usePageTreeSocket). We need to
    // refetch when a task enters or leaves this list. tasksRef (not data) is
    // used so the handler always sees the current task list regardless of when
    // this effect was installed relative to the SWR load.
    const handlePageMoved = (payload: { pageId: string; parentId: string | null }) => {
      const movedIn  = payload.parentId === page.id;
      const movedOut = tasksRef.current?.some(t => t.pageId === payload.pageId);
      if (movedIn || movedOut) mutateTasks();
    };

    socket.on('task:task_added', handleTaskAdded);
    socket.on('task:task_updated', handleTaskUpdated);
    socket.on('task:task_deleted', handleTaskDeleted);
    socket.on('task:tasks_reordered', handleTasksReordered);
    socket.on('page:moved', handlePageMoved);

    return () => {
      socket.off('task:task_added', handleTaskAdded);
      socket.off('task:task_updated', handleTaskUpdated);
      socket.off('task:task_deleted', handleTaskDeleted);
      socket.off('task:tasks_reordered', handleTasksReordered);
      socket.off('page:moved', handlePageMoved);
    };
  }, [socket, connectionStatus, page.id, mutateTasks, writeMachinery]);

  // Derive dynamic status config from API response
  const statusConfigs = useMemo(() => data?.statusConfigs ?? [], [data?.statusConfigs]);
  const statusConfigMap = useMemo(() => buildStatusConfig(statusConfigs), [statusConfigs]);
  const statusOrder = useMemo(() => getStatusOrder(statusConfigs), [statusConfigs]);

  const activeSearch = isFindOpen ? findQuery : search;

  // Filter/search are applied client-side over whatever pages have been loaded so
  // far. Changing either resets "Load More" progress back to just the first page,
  // so a previously-expanded load doesn't linger in a state inconsistent with a
  // fresh filter (cached pages are reused instantly if the user re-expands).
  //
  // Deliberately keyed on `search` (the toolbar filter box), not `activeSearch`: the
  // in-page Cmd+F Find bar (`findQuery`) fires this on every keystroke while typing,
  // which would truncate `data.tasks` back to page 1 mid-search — silently hiding
  // matches on already-loaded pages 2+ and under-reporting the match count to
  // useFindStore. Find should search whatever's already loaded, not reset it.
  useEffect(() => {
    setSize(1);
    // Expansions go too. The filter applies to the top-level rows only — a
    // node's own cache is a separate paginated fetch with no filter in its key
    // — so leaving a subtree open shows completed sub-tasks, struck through,
    // underneath a filter that says Active, and non-matching children under a
    // toolbar search that says otherwise. Collapsing is the honest answer:
    // filtering the subtrees too would mean re-fetching every open node against
    // a lazily-writing route on every keystroke.
    //
    // Cmd+F Find is deliberately NOT in these deps and so does not collapse:
    // it fires per keystroke, and closing the tree under someone mid-search
    // would be worse than the inconsistency. Find's own inability to see nested
    // rows is the filed follow-up.
    setExpandedPaths(EMPTY_EXPANDED);
  }, [filter, search, setSize]);

  // Filter tasks
  const filteredTasks = useMemo(() => data?.tasks.filter(task => {
    // Status filter - use group-based completion detection
    const isDone = isCompletedStatus(task.status, statusConfigs);
    if (filter === 'active' && isDone) return false;
    if (filter === 'completed' && !isDone) return false;

    // Search filter
    if (activeSearch) {
      const searchLower = activeSearch.toLowerCase();
      return task.title.toLowerCase().includes(searchLower);
    }

    return true;
  }) ?? [], [data?.tasks, filter, statusConfigs, activeSearch]);

  // Report filtered task count to find store when search is active
  useEffect(() => {
    if (isFindOpen) {
      reportMatches(findQuery ? filteredTasks.length : 0);
    }
  }, [isFindOpen, findQuery, filteredTasks.length, reportMatches]);

  // Scroll to current find match
  useEffect(() => {
    if (!isFindOpen || !findQuery) return;
    const task = filteredTasks[findIndex];
    if (!task) return;
    const els = document.querySelectorAll(`[data-task-id="${task.id}"]`);
    const visibleEl = Array.from(els).find(el => (el as HTMLElement).offsetParent !== null);
    visibleEl?.scrollIntoView({ block: 'center' });
  }, [findIndex, filteredTasks, isFindOpen, findQuery]);

  // Create new task (with optional status for kanban).
  //
  // Root-level only, despite taking a listPageId: the nested "+ sub-task" rows
  // POST directly (NewSubTaskRow) so they can patch their own cache. That is
  // what makes the refreshSelfTask() below correct — every task created here is
  // a child of the viewed page. Wire a nested caller through this and that stops
  // being true.
  const handleCreateTask = async (listPageId: string, title?: string, status?: string) => {
    const taskTitle = (title ?? newTaskTitle).trim();
    if (!taskTitle || !canEdit) return;

    try {
      await post(`/api/pages/${listPageId}/tasks`, {
        title: taskTitle,
        ...(status && { status }),
      });
      if (!title) setNewTaskTitle('');
      mutateTasks();
      // A new row here is a new sub-task OF this page, so the header's guard
      // needs to see it — same reason completion refreshes it.
      refreshSelfTask();
    } catch {
      toast.error('Failed to create task');
    }
  };

  // Create at the root of the viewed list — the toolbar / new-task-row entry point.
  const handleCreateRootTask = (title?: string, status?: string) =>
    handleCreateTask(page.id, title, status);

  // Update task status
  const handleStatusChange = async (loc: TaskLocation, task: TaskItem, newStatus: string) => {
    if (!canEdit) return;
    // The dropdown can select a done status directly, which is the same
    // completion the checkbox performs and answers to the same guard.
    const blocked = blockedStatusTransition(task, newStatus, statusConfigs);
    if (blocked) {
      toast.error(subTasksBlockedMessage(blocked));
      return;
    }
    // completedAt is guessed only so the row's strikethrough and checkbox move
    // together with the status; the server's real stamp replaces it on resolve.
    const movesToDone = isCompletedStatus(newStatus, statusConfigs);
    const ok = await writeTaskField({
      loc,
      body: { status: newStatus },
      optimistic: {
        status: newStatus,
        completedAt: movesToDone ? new Date().toISOString() : null,
      },
      fallbackMessage: 'Failed to update status',
    });
    // A row here is a sub-task of the page itself, so its completion moves the
    // counts the header's own guard reads.
    if (ok) refreshSelfTask();
  };

  // Update task priority
  const handlePriorityChange = async (loc: TaskLocation, newPriority: string) => {
    if (!canEdit) return;
    await writeTaskField({
      loc,
      body: { priority: newPriority },
      optimistic: { priority: newPriority as TaskItem['priority'] },
      fallbackMessage: 'Failed to update priority',
    });
  };

  // Toggle task completion - uses group-based detection
  const handleToggleComplete = async (loc: TaskLocation, task: TaskItem) => {
    if (!canEdit) return;

    const isDone = isCompletedStatus(task.status, statusConfigs);
    if (!isDone) {
      // Block completion when sub-tasks are incomplete. The server enforces the
      // same rule with a 422; this avoids the round trip and the visible flip.
      const blocked = blockedByOpenSubTasks(task);
      if (blocked) {
        toast.error(subTasksBlockedMessage(blocked));
        return;
      }
    }
    await handleStatusChange(loc, task, resolveToggleStatus(statusConfigs, isDone));
  };

  // Start editing title
  const handleStartEdit = (task: TaskItem) => {
    if (!canEdit) return;
    setEditingTaskId(task.id);
    setEditingTitle(task.title);
  };

  // Shared function to save task title
  const handleSaveTaskTitle = async (loc: TaskLocation, title: string) => {
    // The depth-0 twin of the guard on the nested handler. Unreachable — Rename
    // is disabled and handleStartEdit returns early — but this was the one
    // handler in the block without it, and the uniformity is what a reader
    // relies on when scanning for the hole.
    if (!canEdit) return;
    await writeTaskField({
      loc,
      body: { title },
      optimistic: { title },
      fallbackMessage: 'Failed to update task',
    });
  };

  // Delete task
  const handleDeleteTask = async (loc: TaskLocation) => {
    if (!canEdit) return;

    try {
      await del(`/api/pages/${loc.listPageId}/tasks/${loc.taskId}`);
      mutateTasks();
      // Deleting the last open sub-task unblocks this page's own task just as
      // completing it would; without this the header keeps refusing.
      refreshSelfTask();
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  };

  // Update task assignee (user or agent) - legacy single assignee.
  // No optimistic patch: the row renders the hydrated `assignees` relation, which
  // this request does not supply, so there is nothing honest to show early. The
  // server response reconciles it.
  const handleAssigneeChange = async (loc: TaskLocation, assigneeId: string | null, agentId: string | null) => {
    if (!canEdit) return;
    await writeTaskField({
      loc,
      body: { assigneeId, assigneeAgentId: agentId },
      optimistic: {},
      fallbackMessage: 'Failed to update assignee',
    });
  };

  // Update task assignees (multiple). Same reasoning as the single-assignee
  // handler: ids in, hydrated relations out, so the optimistic patch is empty.
  const handleMultiAssigneeChange = async (loc: TaskLocation, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => {
    if (!canEdit) return;
    await writeTaskField({
      loc,
      body: { assigneeIds },
      optimistic: {},
      fallbackMessage: 'Failed to update assignees',
    });
  };

  // Update task due date
  const handleDueDateChange = async (loc: TaskLocation, dueDate: Date | null) => {
    if (!canEdit) return;
    const iso = dueDate?.toISOString() ?? null;
    await writeTaskField({
      loc,
      body: { dueDate: iso },
      optimistic: { dueDate: iso },
      fallbackMessage: 'Failed to update due date',
    });
  };

  // Collapse every expanded row the moment a drag begins — see the onDragStart
  // comment on DndContext for why this can't wait until the drop.
  //
  // Remembered, though. The pointer sensor fires at 8px, so brushing a drag
  // handle counts as a drag: without this, an accidental nudge or an Escape
  // silently closed every open node in the list and there was no undo. A drag
  // that actually moves something still leaves the tree flat, because the rows
  // beneath it have moved.
  const collapsedForDrag = useRef<Set<TaskNodePath>>(EMPTY_EXPANDED);
  const handleDragStart = () => {
    collapsedForDrag.current = expandedPaths;
    setExpandedPaths(EMPTY_EXPANDED);
  };
  const restoreExpansionsAfterNoOpDrag = () => {
    setExpandedPaths(collapsedForDrag.current);
    collapsedForDrag.current = EMPTY_EXPANDED;
  };

  // Handle drag end - reorder pages (page position is source of truth)
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !canEdit) {
      restoreExpansionsAfterNoOpDrag();
      return;
    }
    collapsedForDrag.current = EMPTY_EXPANDED;

    const tasks = filteredTasks;
    const oldIndex = tasks.findIndex(t => t.id === active.id);
    const newIndex = tasks.findIndex(t => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const draggedTask = tasks[oldIndex];

    // Only reorder tasks with pages
    if (!draggedTask.pageId) {
      toast.error('Cannot reorder tasks without pages');
      return;
    }

    // Calculate new position (between neighbors) on pages.position — the single
    // ordering rail (#2143)
    let newPosition: number;
    if (newIndex === 0) {
      // Moving to first position
      newPosition = (tasks[0].page?.position ?? 0) - 1;
    } else if (newIndex === tasks.length - 1) {
      // Moving to last position
      newPosition = (tasks[tasks.length - 1].page?.position ?? 0) + 1;
    } else {
      // Moving between two tasks
      const beforeTask = newIndex > oldIndex ? tasks[newIndex] : tasks[newIndex - 1];
      const afterTask = newIndex > oldIndex ? tasks[newIndex + 1] : tasks[newIndex];
      const beforePos = beforeTask.page?.position ?? 0;
      const afterPos = afterTask.page?.position ?? 0;
      newPosition = (beforePos + afterPos) / 2;
    }

    // Optimistic update: redistribute the reordered (filtered) list back across the
    // same pages, preserving each page's size and hasMore — the pre-existing,
    // single-page version of this view already dropped filtered-out tasks from the
    // cache during this same optimistic window (arrayMove over `filteredTasks`, not
    // the full list); redistributing by page here just keeps getHasMoreTasks /
    // isLoadingNextTaskPage accurate through it instead of collapsing every loaded
    // page into one. The revalidate below always restores the real server state.
    const reorderedTasks = arrayMove(tasks, oldIndex, newIndex);
    if (taskPages && taskPages.length > 0) {
      mutateTaskPages(redistributeTasksAcrossPages(taskPages, reorderedTasks), false);
    }

    try {
      // Call page reorder API (page position is source of truth)
      await patch('/api/pages/reorder', {
        pageId: draggedTask.pageId,
        newParentId: page.id, // Keep same parent
        newPosition,
      });
      // Refetch to get server state
      mutateTasks();
    } catch {
      // Revert on error
      mutateTasks();
      toast.error('Failed to reorder task');
    }
  };

  // Navigate to task page
  const handleNavigate = (task: TaskItem) => {
    if (task.pageId) {
      router.push(`/dashboard/${page.driveId}/${task.pageId}`);
    }
  };

  // Every write is addressed by TaskLocation so a nested row can target its own
  // parent list. Kanban and the mobile cards only ever render top-level tasks, so
  // they keep the flat TaskHandlers contract via the root binding below.
  const locatedHandlers: LocatedTaskHandlers = {
    onToggleComplete: handleToggleComplete,
    onStatusChange: handleStatusChange,
    onPriorityChange: handlePriorityChange,
    onAssigneeChange: handleAssigneeChange,
    onMultiAssigneeChange: handleMultiAssigneeChange,
    onDueDateChange: handleDueDateChange,
    onSaveTitle: handleSaveTaskTitle,
    onDelete: handleDeleteTask,
    onNavigate: handleNavigate,
    onStartEdit: handleStartEdit,
    onConfigureTriggers: (task) => openTriggerDialog(task, page.id),
  };
  const taskHandlers = bindTaskHandlersToList(locatedHandlers, page.id);

  const rootPath = rootNodePath(page.id);

  // A completed sub-task moves its DIRECT parent's counters, and for a
  // top-level parent that row lives in this cache. Without this the "2/5" on a
  // root row never moves while its children are worked inline.
  const patchRootCounts = useCallback(
    (taskId: string, delta: { total?: number; completed?: number }) => {
      void mutateTaskPages(
        (current) => applySubTaskCountsToPages(current, taskId, delta),
        { revalidate: false },
      );
    },
    [mutateTaskPages],
  );

  /**
   * Refresh the header's view of THIS page as a task.
   *
   * Its completion guard reads sub-task counts, and this page's sub-tasks are
   * exactly the rows below. Without this, clearing the last open sub-task on
   * screen leaves the header still refusing with "Finish 1 sub-task first"
   * until the window is blurred and refocused — in the one workflow the header
   * was added for.
   */
  const refreshSelfTask = useCallback(() => {
    void globalMutate(selfTaskKey(page.id));
  }, [page.id]);
  // Everything a row needs that is identical at every depth. What varies per
  // node — the task, its depth, the list it writes to, and the handlers bound to
  // the cache that holds it — travels on props instead.
  const treeValue = useMemo(() => ({
    canEdit,
    driveId: page.driveId,
    writeMachinery,
    rootStatusConfigs: statusConfigs,
    onNavigate: handleNavigate,
    onStartEdit: handleStartEdit,
    openTriggerDialog,
    expandedPaths,
    toggleExpanded,
    expandNode,
    editingTaskId,
    editingTitle,
    onEditingTitleChange: setEditingTitle,
    onCancelEdit: () => setEditingTaskId(null),
  // handleNavigate and handleStartEdit are redefined every render; including
  // them would defeat the memo, and both read only state already listed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [canEdit, page.driveId, writeMachinery, statusConfigs, openTriggerDialog,
       expandedPaths, toggleExpanded, expandNode, editingTaskId, editingTitle]);

  // Shared between the table, kanban, and mobile card renders — the bounded GET route
  // (limit=100 default) means any of them can silently truncate without this.
  const loadMoreControl = (hasMoreTasks || isLoadingMoreTasks || loadMoreFailed) && (
    <div className="flex flex-col items-center gap-2 py-4">
      {isAnyEditing ? (
        <p className="text-sm text-muted-foreground">Finish editing elsewhere to load more.</p>
      ) : loadMoreFailed && (
        <p className="text-sm text-destructive">Failed to load more tasks.</p>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={loadMoreFailed ? mutateTasks : handleLoadMoreTasks}
        disabled={isLoadingMoreTasks || isAnyEditing}
      >
        {getLoadMoreButtonLabel(loadMoreState, isAnyEditing)}
      </Button>
    </div>
  );

  if (viewMode === 'editor') {
    return (
      // Provided here too, not just around the table: the header renders in
      // this mode as well, and its self-task write reads the write machinery
      // off this context. Without it that write's own socket echo is
      // classified foreign and costs the list the full revalidation the whole
      // optimistic path exists to avoid.
      <TaskTreeProvider value={treeValue}>
      <div className="flex flex-col h-full min-w-0">
        <TaskListHeader
          pageId={page.id}
          viewMode="editor"
          onViewModeChange={setViewMode}
          canEdit={canEdit}
        />
        {canEdit && <Toolbar editor={editorInstance} contentMode="html" />}
        <TaskListDescriptionContent
          pageId={page.id}
          canEdit={canEdit}
          initialContent={page.content}
          className="flex-1 overflow-auto px-4 py-3"
          onEditorChange={setEditorInstance}
        />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t bg-muted/50 text-sm text-muted-foreground shrink-0">
          <span><strong>{data?.tasks.length || 0}</strong> tasks</span>
          <span className="text-xs sm:text-sm">
            Updated {data?.taskList.updatedAt
              ? formatDistanceToNow(new Date(data.taskList.updatedAt), { addSuffix: true })
              : 'never'}
          </span>
        </div>
      </div>
      </TaskTreeProvider>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  // Only a fatal error — no pages ever loaded successfully — replaces the whole view.
  // A failed "Load More" (data already has earlier pages) surfaces via loadMoreFailed
  // in the shared control instead, so already-loaded tasks stay visible.
  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        Failed to load tasks
      </div>
    );
  }

  return (
    <TaskTreeProvider value={treeValue}>
    <div className="flex flex-col h-full min-w-0 @container">
      <TaskListHeader
        pageId={page.id}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        descriptionOpen={descriptionOpen}
        onDescriptionToggle={() => setDescriptionOpen(prev => !prev)}
        canEdit={canEdit}
      />
      {descriptionOpen && (
        <TaskListDescriptionContent
          pageId={page.id}
          canEdit={canEdit}
          initialContent={page.content}
          className="h-[40%] shrink-0 overflow-auto px-4 py-3 border-b"
        />
      )}
      {/* Toolbar */}
      <div className="flex flex-col @[700px]:flex-row @[700px]:flex-wrap @[700px]:items-center @[700px]:justify-between gap-3 px-4 py-3 border-b bg-background">
        <div className="flex flex-col @[700px]:flex-row @[700px]:items-center gap-2">
          {/* Filter tabs */}
          <div className="flex items-center bg-muted rounded-md p-0.5">
            {(['all', 'active', 'completed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded transition-colors flex-1 @[700px]:flex-none',
                  filter === f
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Filter tasks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-full @[700px]:w-48"
            />
          </div>
        </div>

        <div className="flex flex-col @[700px]:flex-row @[700px]:items-center gap-2 w-full @[700px]:w-auto">
          <div className="flex items-center gap-2 @[700px]:contents">
            {canEdit && (
              <StatusConfigManager
                pageId={page.id}
                statusConfigs={statusConfigs}
                onConfigsChanged={() => mutateTasks()}
              />
            )}

            {canManageWorkflows && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1"
                onClick={() => setWorkflowsDialogOpen(true)}
              >
                <Zap className="h-3.5 w-3.5" />
                <span className="hidden @[700px]:inline">Workflows</span>
              </Button>
            )}
          </div>

          {canEdit && viewMode === 'table' && (
            <Button
              size="sm"
              className="w-full @[700px]:w-auto"
              onClick={() => {
                const mobileInput = document.getElementById('new-task-input-mobile');
                const desktopInput = document.getElementById('new-task-input');
                // offsetParent is null for CSS-hidden elements; pick the visible input
                const input = desktopInput?.offsetParent ? desktopInput : mobileInput;
                input?.scrollIntoView({ block: 'nearest' });
                input?.focus();
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              New Task
            </Button>
          )}
        </div>
      </div>

      {/* Narrow Card View — table/card switch only; Kanban has its own always-visible view below */}
      {viewMode !== 'kanban' && (
      <div className="flex-1 overflow-auto @[700px]:hidden p-4 space-y-3">
        {filteredTasks.map((task) => (
          <div key={task.id} data-task-id={task.id}>
          <MobileTaskCard
            task={task}
            canEdit={canEdit}
            onToggleComplete={taskHandlers.onToggleComplete}
            onStatusChange={taskHandlers.onStatusChange}
            onPriorityChange={taskHandlers.onPriorityChange}
            onMultiAssigneeChange={taskHandlers.onMultiAssigneeChange!}
            onDueDateChange={taskHandlers.onDueDateChange}
            onSaveTitle={taskHandlers.onSaveTitle}
            onStartEdit={taskHandlers.onStartEdit}
            onDelete={taskHandlers.onDelete}
            onNavigate={taskHandlers.onNavigate}
            onConfigureTriggers={taskHandlers.onConfigureTriggers}
            driveId={page.driveId}
            isEditing={editingTaskId === task.id}
            editingTitle={editingTitle}
            onEditingTitleChange={setEditingTitle}
            onCancelEdit={() => setEditingTaskId(null)}
            statusConfigMap={statusConfigMap}
            statusOrder={statusOrder}
            statusConfigs={statusConfigs}
          />
          </div>
        ))}

        {loadMoreControl}

        {/* Mobile new task input */}
        {canEdit && (
          <div className="border rounded-lg p-4 bg-card">
            <Input
              id="new-task-input-mobile"
              placeholder="+ Add a new task..."
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateRootTask();
              }}
              className="border-0 shadow-none focus-visible:ring-0 px-0"
            />
          </div>
        )}

        {filteredTasks.length === 0 && !canEdit && (
          <div className="text-center py-12 text-muted-foreground">
            No tasks yet
          </div>
        )}
      </div>
      )}

      {/* Kanban View — horizontal-scrolling board; visible at any pane width via its own narrow-column step (@max-[500px]:w-60) */}
      {viewMode === 'kanban' && (
        <div className="flex-1 overflow-auto">
          <TaskKanbanView
            tasks={filteredTasks}
            driveId={page.driveId}
            _pageId={page.id}
            canEdit={canEdit}
            handlers={taskHandlers}
            editingTaskId={editingTaskId}
            editingTitle={editingTitle}
            onEditingTitleChange={setEditingTitle}
            onCancelEdit={() => setEditingTaskId(null)}
            onCreateTask={handleCreateRootTask}
            statusConfigs={statusConfigs}
          />
          {loadMoreControl}
        </div>
      )}

      {/* Wide View (Table) — needs ~700px minimum; columns don't reflow */}
      {viewMode !== 'kanban' && (
      <div className="flex-1 overflow-auto hidden @[700px]:block">
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              // Collapse BEFORE the drag, not after. Today the expansion row is
              // always rendered and merely CSS-`hidden`, so it has no layout and
              // verticalListSortingStrategy sees contiguous sortables either way.
              // Once expansions render real sibling rows with layout, dragging
              // with rows open produces wrong transforms and wrong drop targets.
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              // A cancelled drag (Escape, or a pointer lost outside the window)
              // never reaches onDragEnd, so without this the expansions the
              // start collapsed would stay closed with nothing having moved.
              onDragCancel={restoreExpansionsAfterNoOpDrag}
            >
              <div className="overflow-x-auto">
              {/* treegrid, not table: the rows carry aria-level and (when they
                  can expand) aria-expanded, and assistive technology ignores
                  both inside a plain `table` role — the nesting and expansion
                  state would simply not be announced. */}
              <Table role="treegrid" aria-label="Tasks">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="w-10"></TableHead>
                    <TableHead className="min-w-[300px]">Task</TableHead>
                    <TableHead className="w-32">Status</TableHead>
                    <TableHead className="w-28">Priority</TableHead>
                    <TableHead className="w-32">Assignee</TableHead>
                    <TableHead className="w-28">Due Date</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <SortableContext
                  items={filteredTasks.map(t => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <TableBody>
                    {filteredTasks.map((task, index) => (
                      <TaskRowGroup
                        key={task.id}
                        task={task}
                        depth={0}
                        posInSet={index + 1}
                        // Same rule as a sub-list: only claim a size when the
                        // whole set is loaded. This list pages, so with more to
                        // come any number would describe rows that are not here.
                        setSize={hasMoreTasks ? undefined : filteredTasks.length}
                        listPageId={page.id}
                        path={makeNodePath(rootPath, task.id)}
                        handlers={locatedHandlers}
                        statusConfigs={statusConfigs}
                        onCountDelta={(delta) => patchRootCounts(task.id, delta)}
                        renderRow={(cells, rowTree) => (
                          <SortableTaskRow
                            task={task}
                            posInSet={index + 1}
                            setSize={hasMoreTasks ? undefined : filteredTasks.length}
                            canEdit={canEdit}
                            isCompleted={isCompletedStatus(task.status, statusConfigs)}
                            expandable={rowTree.expandable}
                            isExpanded={rowTree.isExpanded}
                            contextMenu={
                              <ContextMenuContent>
                                {task.pageId && (
                                  <ContextMenuItem onSelect={() => handleNavigate(task)}>
                                    <FileText className="h-4 w-4 mr-2" />
                                    Open
                                  </ContextMenuItem>
                                )}
                                <ContextMenuItem onSelect={() => handleStartEdit(task)} disabled={!canEdit}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Rename
                                </ContextMenuItem>
                                <ContextMenuItem onSelect={() => openTriggerDialog(task, page.id)} disabled={!canEdit}>
                                  <Zap className="h-4 w-4 mr-2" />
                                  Agent triggers…
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onSelect={() => handleDeleteTask({ listPageId: page.id, taskId: task.id })}
                                  className="text-destructive"
                                  disabled={!canEdit}
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </ContextMenuItem>
                              </ContextMenuContent>
                            }
                          >
                            {cells}
                          </SortableTaskRow>
                        )}
                      />
                    ))}
                  </TableBody>
                </SortableContext>

                {/* New task row - outside SortableContext */}
                {canEdit && (
                  <TableBody>
                    <TableRow>
                      <TableCell></TableCell>
                      <TableCell>
                        <Checkbox disabled className="opacity-30" />
                      </TableCell>
                      <TableCell colSpan={TASK_TABLE_COLUMN_COUNT - 2}>
                        <Input
                          id="new-task-input"
                          placeholder="+ Add a new task..."
                          value={newTaskTitle}
                          onChange={(e) => setNewTaskTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreateRootTask();
                          }}
                          className="border-0 shadow-none focus-visible:ring-0 px-0"
                        />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                )}
              </Table>
              </div>
            </DndContext>

            {filteredTasks.length === 0 && !canEdit && (
              <div className="text-center py-12 text-muted-foreground">
                No tasks yet
              </div>
            )}
          </>
        {loadMoreControl}
      </div>
      )}

      {/* Footer stats */}
      <div className="flex flex-col @[420px]:flex-row @[420px]:items-center @[420px]:justify-between gap-2 px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t bg-muted/50 text-sm text-muted-foreground">
        <span><strong>{data?.tasks.length || 0}</strong> tasks</span>
        <span className="text-xs @[420px]:text-sm">
          Updated {data?.taskList.updatedAt
            ? formatDistanceToNow(new Date(data.taskList.updatedAt), { addSuffix: true })
            : 'never'}
        </span>
      </div>

      {triggerDialogTask && (
        <TaskAgentTriggersDialog
          open={!!triggerDialogTask}
          onOpenChange={(open) => { if (!open) setTriggerDialogTask(null); }}
          taskId={triggerDialogTask.task.id}
          taskTitle={triggerDialogTask.task.title}
          pageId={triggerDialogTask.listPageId}
          driveId={page.driveId}
          hasDueDate={!!triggerDialogTask.task.dueDate}
          onSaved={() => {
            mutateTasks();
            // The dialog can be opened from a NESTED row, and the bell it
            // toggles is rendered from that node's own cache — which mutateTasks
            // does not touch and which has no revalidation trigger of its own.
            writeMachinery.refreshNodeCaches();
          }}
        />
      )}

      <TaskListWorkflowsDialog
        open={workflowsDialogOpen}
        onOpenChange={setWorkflowsDialogOpen}
        driveId={page.driveId}
        pageId={page.id}
        taskListTitle={data?.taskList.title ?? page.title ?? 'Task list'}
      />
    </div>
    </TaskTreeProvider>
  );
}

export default memo(
  TaskListView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.driveId === nextProps.page.driveId
);
