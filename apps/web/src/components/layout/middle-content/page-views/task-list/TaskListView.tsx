'use client';

import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { type Editor } from '@tiptap/react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import useSWRInfinite from 'swr/infinite';
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
  ChevronRight,
  ChevronDown,
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
import Toolbar from '@/components/editors/Toolbar';
import { TaskRowDescription } from './TaskRowDescription';
import { StatusConfigManager } from './StatusConfigManager';
import { TaskAgentTriggersDialog } from './TaskAgentTriggersDialog';
import { TaskListWorkflowsDialog } from './TaskListWorkflowsDialog';
import {
  TaskItem,
  TaskListData,
  TaskStatusConfig,
  buildStatusConfig,
  getStatusOrder,
  isCompletedStatus,
  PRIORITY_CONFIG,
  TaskHandlers,
  canExpandTask,
} from './task-list-types';

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
  onStatusChange: (taskId: string, status: string) => void;
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
          onValueChange={(value) => onStatusChange(task.id, value)}
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

export const getExpansionRowClass = (isExpanded: boolean): string =>
  isExpanded ? '' : 'hidden';

export const toggleSet = (set: Set<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
};

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

// Sortable row component for drag-and-drop
interface SortableTaskRowProps {
  task: TaskItem;
  canEdit: boolean;
  isCompleted: boolean;
  isExpanded: boolean;
  contextMenu?: React.ReactNode;
  children: React.ReactNode;
}

function SortableTaskRow({ task, canEdit, isCompleted, isExpanded, contextMenu, children }: SortableTaskRowProps) {
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

  const expansionRow = (
    <tr key={`${task.id}-desc`} className={getExpansionRowClass(isExpanded)}>
      <td colSpan={8} className="px-4 py-2 border-b bg-muted/20">
        {isExpanded && <TaskRowDescription task={task} />}
      </td>
    </tr>
  );

  if (!contextMenu) {
    return (
      <>
        {row}
        {expansionRow}
      </>
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        {contextMenu}
      </ContextMenu>
      {expansionRow}
    </>
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
  const [triggerDialogTask, setTriggerDialogTask] = useState<TaskItem | null>(null);
  const [workflowsDialogOpen, setWorkflowsDialogOpen] = useState(false);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const toggleTaskExpand = (id: string) => setExpandedTaskIds(prev => toggleSet(prev, id));
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

  useEditingSession(page.id, !!editingTaskId, 'form', {
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
    const handleTaskAdded = () => {
      mutateTasks();
    };

    const handleTaskUpdated = () => {
      mutateTasks();
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
  }, [socket, connectionStatus, page.id, mutateTasks]);

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

  // Create new task (with optional status for kanban)
  const handleCreateTask = async (title?: string, status?: string) => {
    const taskTitle = (title ?? newTaskTitle).trim();
    if (!taskTitle || !canEdit) return;

    try {
      await post(`/api/pages/${page.id}/tasks`, {
        title: taskTitle,
        ...(status && { status }),
      });
      if (!title) setNewTaskTitle('');
      mutateTasks();
    } catch {
      toast.error('Failed to create task');
    }
  };

  // Update task status
  const handleStatusChange = async (taskId: string, newStatus: string) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { status: newStatus });
      mutateTasks();
    } catch {
      toast.error('Failed to update status');
    }
  };

  // Update task priority
  const handlePriorityChange = async (taskId: string, newPriority: string) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { priority: newPriority });
      mutateTasks();
    } catch {
      toast.error('Failed to update priority');
    }
  };

  // Toggle task completion - uses group-based detection
  const handleToggleComplete = async (task: TaskItem) => {
    if (!canEdit) return;

    const isDone = isCompletedStatus(task.status, statusConfigs);
    if (isDone) {
      // Move to first "todo" group status
      const todoStatus = statusOrder.find(slug => {
        const cfg = statusConfigMap[slug];
        return cfg && cfg.group === 'todo';
      }) || 'pending';
      await handleStatusChange(task.id, todoStatus);
    } else {
      // Block completion when sub-tasks are incomplete
      const subTaskCount = task.subTaskCount ?? 0;
      const subTaskCompletedCount = task.subTaskCompletedCount ?? 0;
      if (subTaskCount > 0 && subTaskCompletedCount < subTaskCount) {
        const pending = subTaskCount - subTaskCompletedCount;
        toast.error(`Finish ${pending} sub-task${pending > 1 ? 's' : ''} first`);
        return;
      }
      // Move to first "done" group status
      const doneStatus = statusOrder.find(slug => {
        const cfg = statusConfigMap[slug];
        return cfg && cfg.group === 'done';
      }) || 'completed';
      await handleStatusChange(task.id, doneStatus);
    }
  };

  // Start editing title
  const handleStartEdit = (task: TaskItem) => {
    if (!canEdit) return;
    setEditingTaskId(task.id);
    setEditingTitle(task.title);
  };

  // Shared function to save task title
  const handleSaveTaskTitle = async (taskId: string, title: string) => {
    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { title });
      mutateTasks();
    } catch {
      toast.error('Failed to update task');
    }
  };

  // Save edited title (wraps shared function with state cleanup)
  const handleSaveEdit = async () => {
    if (!editingTaskId || !editingTitle.trim()) {
      setEditingTaskId(null);
      return;
    }

    await handleSaveTaskTitle(editingTaskId, editingTitle.trim());
    setEditingTaskId(null);
  };

  // Delete task
  const handleDeleteTask = async (taskId: string) => {
    if (!canEdit) return;

    try {
      await del(`/api/pages/${page.id}/tasks/${taskId}`);
      mutateTasks();
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
    }
  };

  // Update task assignee (user or agent) - legacy single assignee
  const handleAssigneeChange = async (taskId: string, assigneeId: string | null, agentId: string | null) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, {
        assigneeId,
        assigneeAgentId: agentId,
      });
      mutateTasks();
    } catch {
      toast.error('Failed to update assignee');
    }
  };

  // Update task assignees (multiple)
  const handleMultiAssigneeChange = async (taskId: string, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { assigneeIds });
      mutateTasks();
    } catch {
      toast.error('Failed to update assignees');
    }
  };

  // Update task due date
  const handleDueDateChange = async (taskId: string, dueDate: Date | null) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, {
        dueDate: dueDate?.toISOString() || null,
      });
      mutateTasks();
    } catch {
      toast.error('Failed to update due date');
    }
  };

  // Handle drag end - reorder pages (page position is source of truth)
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setExpandedTaskIds(new Set()); // collapse all rows before reorder
    if (!over || active.id === over.id || !canEdit) return;

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

  // Handlers object for kanban view
  const taskHandlers: TaskHandlers = {
    onToggleComplete: handleToggleComplete,
    onStatusChange: handleStatusChange,
    onPriorityChange: handlePriorityChange,
    onAssigneeChange: handleAssigneeChange,
    onDueDateChange: handleDueDateChange,
    onSaveTitle: handleSaveTaskTitle,
    onDelete: handleDeleteTask,
    onNavigate: handleNavigate,
    onStartEdit: handleStartEdit,
    onConfigureTriggers: setTriggerDialogTask,
  };

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
    <div className="flex flex-col h-full min-w-0">
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-b bg-background">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          {/* Filter tabs */}
          <div className="flex items-center bg-muted rounded-md p-0.5">
            {(['all', 'active', 'completed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded transition-colors flex-1 sm:flex-none',
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
              className="pl-9 w-full sm:w-48"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center gap-2 sm:contents">
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
                <span className="hidden sm:inline">Workflows</span>
              </Button>
            )}
          </div>

          {canEdit && viewMode === 'table' && (
            <Button
              size="sm"
              className="w-full sm:w-auto"
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

      {/* Mobile Card View */}
      <div className="flex-1 overflow-auto md:hidden p-4 space-y-3">
        {filteredTasks.map((task) => (
          <div key={task.id} data-task-id={task.id}>
          <MobileTaskCard
            task={task}
            canEdit={canEdit}
            onToggleComplete={handleToggleComplete}
            onStatusChange={handleStatusChange}
            onPriorityChange={handlePriorityChange}
            onMultiAssigneeChange={handleMultiAssigneeChange}
            onDueDateChange={handleDueDateChange}
            onSaveTitle={handleSaveTaskTitle}
            onStartEdit={handleStartEdit}
            onDelete={handleDeleteTask}
            onNavigate={(t) => {
              if (t.pageId) {
                router.push(`/dashboard/${page.driveId}/${t.pageId}`);
              }
            }}
            onConfigureTriggers={(t) => setTriggerDialogTask(t)}
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
                if (e.key === 'Enter') handleCreateTask();
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

      {/* Desktop View (Table or Kanban) */}
      <div className="flex-1 overflow-auto hidden md:block">
        {viewMode === 'kanban' ? (
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
            onCreateTask={handleCreateTask}
            statusConfigs={statusConfigs}
          />
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <div className="overflow-x-auto">
              <Table>
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
                    {filteredTasks.map((task) => (
                      <SortableTaskRow
                        key={task.id}
                        task={task}
                        canEdit={canEdit}
                        isCompleted={isCompletedStatus(task.status, statusConfigs)}
                        isExpanded={expandedTaskIds.has(task.id)}
                        contextMenu={
                          <ContextMenuContent>
                            {task.pageId && (
                              <ContextMenuItem onSelect={() => router.push(`/dashboard/${page.driveId}/${task.pageId}`)}>
                                <FileText className="h-4 w-4 mr-2" />
                                Open
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem onSelect={() => handleStartEdit(task)} disabled={!canEdit}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Rename
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => setTriggerDialogTask(task)} disabled={!canEdit}>
                              <Zap className="h-4 w-4 mr-2" />
                              Agent triggers…
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => handleDeleteTask(task.id)}
                              className="text-destructive"
                              disabled={!canEdit}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </ContextMenuItem>
                          </ContextMenuContent>
                        }
                      >
                        {/* Checkbox */}
                        <TableCell>
                          <Checkbox
                            checked={isCompletedStatus(task.status, statusConfigs)}
                            onCheckedChange={() => handleToggleComplete(task)}
                            disabled={!canEdit}
                          />
                        </TableCell>

                        {/* Title */}
                        <TableCell>
                          {editingTaskId === task.id ? (
                            <Input
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onBlur={handleSaveEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveEdit();
                                if (e.key === 'Escape') setEditingTaskId(null);
                              }}
                              autoFocus
                              className="h-8"
                            />
                          ) : (
                            <div className="flex items-center gap-1">
                              {canExpandTask(task) ? (
                                <button
                                  type="button"
                                  aria-label={expandedTaskIds.has(task.id) ? 'Collapse description' : 'Expand description'}
                                  onClick={() => toggleTaskExpand(task.id)}
                                  className="text-muted-foreground hover:text-foreground shrink-0"
                                >
                                  {expandedTaskIds.has(task.id)
                                    ? <ChevronDown className="h-3.5 w-3.5" />
                                    : <ChevronRight className="h-3.5 w-3.5" />}
                                </button>
                              ) : (
                                <span className="inline-block w-[19px] shrink-0" />
                              )}
                              <span
                                className={cn(
                                  'cursor-pointer hover:text-primary hover:underline',
                                  isCompletedStatus(task.status, statusConfigs) && 'line-through'
                                )}
                                onClick={() => {
                                  if (task.pageId) {
                                    router.push(`/dashboard/${page.driveId}/${task.pageId}`);
                                  }
                                }}
                              >
                                {task.title}
                              </span>
                            </div>
                          )}
                        </TableCell>

                        {/* Status - uses dynamic status configs */}
                        <TableCell>
                          <Select
                            value={task.status}
                            onValueChange={(value) => handleStatusChange(task.id, value)}
                            disabled={!canEdit}
                          >
                            <SelectTrigger className="h-8 w-28">
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
                        </TableCell>

                        {/* Priority */}
                        <TableCell>
                          <Select
                            value={task.priority}
                            onValueChange={(value) => handlePriorityChange(task.id, value)}
                            disabled={!canEdit}
                          >
                            <SelectTrigger className="h-8 w-28">
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
                        </TableCell>

                        {/* Multiple Assignees */}
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <MultiAssigneeSelect
                              driveId={page.driveId}
                              assignees={task.assignees || []}
                              onUpdate={(assigneeIds) => handleMultiAssigneeChange(task.id, assigneeIds)}
                              disabled={!canEdit}
                            />
                            {canEdit && (task.activeTriggerCount ?? 0) > 0 && (
                              <button
                                type="button"
                                onClick={() => setTriggerDialogTask(task)}
                                title="Agent trigger configured — click to edit"
                                aria-label="Agent trigger configured — click to edit"
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-300/60 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300"
                              >
                                <Bell className="h-3 w-3" />
                                <span className="sr-only">Agent trigger configured</span>
                              </button>
                            )}
                          </div>
                        </TableCell>

                        {/* Due Date */}
                        <TableCell>
                          <DueDatePicker
                            currentDate={task.dueDate}
                            onSelect={(date) => handleDueDateChange(task.id, date)}
                            disabled={!canEdit}
                          />
                        </TableCell>

                        {/* Actions */}
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {task.pageId && (
                                <DropdownMenuItem onClick={() => router.push(`/dashboard/${page.driveId}/${task.pageId}`)}>
                                  <FileText className="h-4 w-4 mr-2" />
                                  Open
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => handleStartEdit(task)} disabled={!canEdit}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setTriggerDialogTask(task)} disabled={!canEdit}>
                                <Zap className="h-4 w-4 mr-2" />
                                Agent triggers…
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleDeleteTask(task.id)}
                                className="text-destructive"
                                disabled={!canEdit}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </SortableTaskRow>
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
                      <TableCell colSpan={6}>
                        <Input
                          id="new-task-input"
                          placeholder="+ Add a new task..."
                          value={newTaskTitle}
                          onChange={(e) => setNewTaskTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreateTask();
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
        )}

        {loadMoreControl}
      </div>

      {/* Footer stats */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t bg-muted/50 text-sm text-muted-foreground">
        <span><strong>{data?.tasks.length || 0}</strong> tasks</span>
        <span className="text-xs sm:text-sm">
          Updated {data?.taskList.updatedAt
            ? formatDistanceToNow(new Date(data.taskList.updatedAt), { addSuffix: true })
            : 'never'}
        </span>
      </div>

      {triggerDialogTask && (
        <TaskAgentTriggersDialog
          open={!!triggerDialogTask}
          onOpenChange={(open) => { if (!open) setTriggerDialogTask(null); }}
          taskId={triggerDialogTask.id}
          taskTitle={triggerDialogTask.title}
          pageId={page.id}
          driveId={page.driveId}
          hasDueDate={!!triggerDialogTask.dueDate}
          onSaved={() => mutateTasks()}
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
  );
}

export default memo(
  TaskListView,
  (prevProps, nextProps) =>
    prevProps.page.id === nextProps.page.id &&
    prevProps.page.driveId === nextProps.page.driveId
);
