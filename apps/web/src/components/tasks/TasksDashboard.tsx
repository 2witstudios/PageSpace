'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  Search,
  LayoutList,
  Kanban,
} from 'lucide-react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { fetchWithAuth, patch, del } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { useMobile } from '@/hooks/useMobile';
import { useCapacitor } from '@/hooks/useCapacitor';
import {
  buildStatusConfig,
  type TaskPriority,
  type TaskStatusConfig,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';
import type { Task, TaskFilters, Drive, Pagination, StatusConfigsByTaskList } from './types';
import { getStatusDisplay } from './task-helpers';
import { FilterControls } from './FilterControls';
import { TaskCompactRow } from './TaskCompactRow';
import { TaskDetailSheet } from './TaskDetailSheet';
import { TaskFilterSheet, TaskFilterButton } from './TaskFilterSheet';
import { TaskTableRow } from './TaskTableRow';
import { TaskLoadingSkeleton, TaskEmptyState } from './TaskStates';
import { KanbanColumn, KanbanCard } from './TaskKanbanComponents';

const STATUS_GROUPS: TaskStatusGroup[] = ['todo', 'in_progress', 'done'];

interface TasksDashboardProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
}

type DueDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
type AssigneeFilter = 'mine' | 'all';

interface ExtendedFilters extends TaskFilters {
  search?: string;
  dueDateFilter?: DueDateFilter;
  assigneeFilter?: AssigneeFilter;
}

export function TasksDashboard({ context, driveId: initialDriveId, driveName }: TasksDashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // State
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [statusConfigsByTaskList, setStatusConfigsByTaskList] = useState<StatusConfigsByTaskList>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);

  // View mode
  const viewMode = useLayoutStore((state) => state.taskListViewMode);
  const setViewMode = useLayoutStore((state) => state.setTaskListViewMode);
  const isMobile = useMobile();
  const { isNative } = useCapacitor();
  const isMobileTaskLayout = isMobile || isNative;

  // Editing state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Mobile sheet state
  const [detailSheetTask, setDetailSheetTask] = useState<Task | null>(null);
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Filter state from URL params
  const [selectedDriveId, setSelectedDriveId] = useState<string | undefined>(initialDriveId);
  const [filters, setFilters] = useState<ExtendedFilters>(() => ({
    status: searchParams.get('status') || undefined,
    priority: (searchParams.get('priority') as TaskPriority) || undefined,
    driveId: searchParams.get('driveId') || undefined,
    search: searchParams.get('search') || undefined,
    dueDateFilter: (searchParams.get('dueDateFilter') as DueDateFilter) || undefined,
    assigneeFilter: (searchParams.get('assigneeFilter') as AssigneeFilter) || 'mine',
  }));

  // Track last data refresh time
  const [lastRefreshTime, setLastRefreshTime] = useState<Date>(new Date());

  // Local search state (debounced)
  const [searchValue, setSearchValue] = useState(filters.search || '');
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Ref to capture latest selectedDriveId for debounce callback
  const selectedDriveIdRef = useRef(selectedDriveId);

  // Keep ref in sync with selectedDriveId state
  useEffect(() => {
    selectedDriveIdRef.current = selectedDriveId;
  }, [selectedDriveId]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Update URL when filters change
  const updateUrl = useCallback((newFilters: ExtendedFilters, newDriveId?: string) => {
    const params = new URLSearchParams();

    if (newFilters.status) {
      params.set('status', newFilters.status);
    }
    if (newFilters.priority) {
      params.set('priority', newFilters.priority);
    }
    if (newFilters.search) {
      params.set('search', newFilters.search);
    }
    if (newFilters.dueDateFilter && newFilters.dueDateFilter !== 'all') {
      params.set('dueDateFilter', newFilters.dueDateFilter);
    }
    if (newFilters.assigneeFilter && newFilters.assigneeFilter !== 'mine') {
      params.set('assigneeFilter', newFilters.assigneeFilter);
    }
    // For user context, driveId is a filter (not in the URL path)
    if (newFilters.driveId && !newDriveId) {
      params.set('driveId', newFilters.driveId);
    }

    const queryString = params.toString();
    const basePath = newDriveId
      ? `/dashboard/${newDriveId}/tasks`
      : '/dashboard/tasks';
    const newUrl = queryString ? `${basePath}?${queryString}` : basePath;

    router.replace(newUrl, { scroll: false });
  }, [router]);

  // Handle search with debounce
  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      setFilters((prev) => {
        const next = { ...prev, search: value || undefined };
        updateUrl(next, selectedDriveIdRef.current);
        return next;
      });
    }, 300);
  }, [updateUrl]);

  // Fetch drives for the selector
  const fetchDrives = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/drives');
      if (!response.ok) throw new Error('Failed to fetch drives');
      const data = await response.json();
      setDrives(data);

      // If context is 'drive' and no drive selected, select first one
      if (context === 'drive' && !selectedDriveId && data.length > 0) {
        setSelectedDriveId(data[0].id);
      }
    } catch (err) {
      console.error('Error fetching drives:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedDriveId is only checked, not derived from
  }, [context]);

  // Fetch tasks
  const fetchTasks = useCallback(
    async (offset = 0, append = false) => {
      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set('context', context);
        params.set('limit', '50');
        params.set('offset', offset.toString());

        if (context === 'drive' && selectedDriveId) {
          params.set('driveId', selectedDriveId);
        } else if (context === 'user' && filters.driveId) {
          params.set('driveId', filters.driveId);
        }
        if (filters.status) {
          params.set('status', filters.status);
        }
        if (filters.priority) {
          params.set('priority', filters.priority);
        }
        if (filters.search) {
          params.set('search', filters.search);
        }
        if (filters.dueDateFilter && filters.dueDateFilter !== 'all') {
          params.set('dueDateFilter', filters.dueDateFilter);
        }
        // Handle assignee filter - 'all' shows all tasks, 'mine' (default) shows only user's tasks
        if (filters.assigneeFilter === 'all') {
          params.set('showAllAssignees', 'true');
        }

        const response = await fetchWithAuth(`/api/tasks?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch tasks');
        }

        const data = await response.json();

        if (append) {
          setTasks((prev) => [...prev, ...data.tasks]);
          // Merge new configs into existing ones
          if (data.statusConfigsByTaskList) {
            setStatusConfigsByTaskList(prev => ({ ...prev, ...data.statusConfigsByTaskList }));
          }
        } else {
          setTasks(data.tasks);
          if (data.statusConfigsByTaskList) {
            setStatusConfigsByTaskList(data.statusConfigsByTaskList);
          }
        }
        setPagination(data.pagination);
        setLastRefreshTime(new Date());
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch tasks';
        setError(message);
        toast.error(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [context, selectedDriveId, filters]
  );

  // Initial load
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // Fetch tasks when filters or drive changes
  useEffect(() => {
    if (context === 'user' || (context === 'drive' && selectedDriveId)) {
      fetchTasks();
    }
  }, [context, selectedDriveId, filters, fetchTasks]);

  // Register/unregister editing state for UI refresh protection
  useEffect(() => {
    const dashboardId = `tasks-dashboard-${context}-${selectedDriveId || 'all'}`;
    if (editingTaskId) {
      useEditingStore.getState().startEditing(dashboardId, 'form', { componentName: 'TasksDashboard' });
    } else {
      useEditingStore.getState().endEditing(dashboardId);
    }
    return () => useEditingStore.getState().endEditing(dashboardId);
  }, [editingTaskId, context, selectedDriveId]);

  // Handlers
  const handleLoadMore = () => {
    if (pagination?.hasMore) {
      fetchTasks(pagination.offset + pagination.limit, true);
    }
  };

  const handleRefresh = async () => {
    await fetchTasks();
  };

  const handleFiltersChange = (newFilters: Partial<ExtendedFilters>) => {
    const updated = { ...filters, ...newFilters };
    setFilters(updated);
    updateUrl(updated, selectedDriveId);
  };

  const handleDriveChange = (driveId: string) => {
    if (context === 'drive') {
      setSelectedDriveId(driveId);
      const updatedFilters = { ...filters };
      setFilters(updatedFilters);
      updateUrl(updatedFilters, driveId);
    } else {
      const updatedFilters = { ...filters, driveId: driveId || undefined };
      setFilters(updatedFilters);
      updateUrl(updatedFilters, undefined);
    }
  };

  // Helper to get status configs for a specific task
  const getConfigsForTask = useCallback((task: Task): TaskStatusConfig[] => {
    return statusConfigsByTaskList[task.taskListId] || [];
  }, [statusConfigsByTaskList]);

  // Task update handlers
  const handleStatusChange = async (task: Task, newStatus: string) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { status: newStatus });
      // Resolve status metadata from task's own configs for optimistic update
      const configs = getConfigsForTask(task);
      const configMap = buildStatusConfig(configs);
      const matched = configMap[newStatus];
      const fallback = DEFAULT_STATUS_CONFIG[newStatus];
      setTasks(prev => prev.map(t =>
        t.id === task.id
          ? {
              ...t,
              status: newStatus,
              statusGroup: matched?.group ?? fallback?.group ?? t.statusGroup,
              statusLabel: matched?.label ?? fallback?.label ?? t.statusLabel,
              statusColor: matched?.color ?? fallback?.color ?? t.statusColor,
            }
          : t
      ));
    } catch {
      toast.error('Failed to update status');
      fetchTasks(); // Revert on error
    }
  };

  const handlePriorityChange = async (task: Task, newPriority: string) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { priority: newPriority });
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, priority: newPriority as TaskPriority } : t
      ));
    } catch {
      toast.error('Failed to update priority');
      fetchTasks();
    }
  };

  const handleToggleComplete = async (task: Task) => {
    const statusDisplay = getStatusDisplay(task);
    const configs = getConfigsForTask(task);
    const sorted = [...configs].sort((a, b) => a.position - b.position);
    if (statusDisplay.group === 'done') {
      const firstTodo = sorted.find(c => c.group === 'todo');
      await handleStatusChange(task, firstTodo?.slug || 'pending');
    } else {
      const firstDone = sorted.find(c => c.group === 'done');
      await handleStatusChange(task, firstDone?.slug || 'completed');
    }
  };

  const handleStartEdit = (task: Task) => {
    setEditingTaskId(task.id);
    setEditingTitle(task.title);
  };

  const handleSaveTitle = async (task: Task, title: string) => {
    if (!task.taskListPageId || !title.trim()) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { title: title.trim() });
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, title: title.trim() } : t
      ));
    } catch {
      toast.error('Failed to update task title');
      fetchTasks();
    }
    setEditingTaskId(null);
  };

  const handleMultiAssigneeChange = async (task: Task, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, {
        assigneeIds,
      });
      fetchTasks(); // Refetch to get updated assignee data
    } catch {
      toast.error('Failed to update assignees');
      fetchTasks();
    }
  };

  const handleDueDateChange = async (task: Task, dueDate: Date | null) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, {
        dueDate: dueDate?.toISOString() || null,
      });
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, dueDate: dueDate?.toISOString() || null } : t
      ));
    } catch {
      toast.error('Failed to update due date');
      fetchTasks();
    }
  };

  const handleDeleteTask = async (task: Task) => {
    if (!task.taskListPageId) return;

    try {
      await del(`/api/pages/${task.taskListPageId}/tasks/${task.id}`);
      setTasks(prev => prev.filter(t => t.id !== task.id));
      toast.success('Task deleted');
    } catch {
      toast.error('Failed to delete task');
      fetchTasks();
    }
  };

  const handleNavigate = (task: Task) => {
    if (task.pageId && task.driveId) {
      router.push(`/dashboard/${task.driveId}/${task.pageId}`);
    }
  };

  // Kanban drag-and-drop
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find(t => t.id === event.active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const draggedTask = tasks.find(t => t.id === active.id);
    if (!draggedTask) return;

    // Determine target status group
    let targetGroup: TaskStatusGroup | null = null;

    // Check if dropped on a group column
    if (STATUS_GROUPS.includes(over.id as TaskStatusGroup)) {
      targetGroup = over.id as TaskStatusGroup;
    } else {
      // Check if dropped on a task - use that task's status group
      const targetTask = tasks.find(t => t.id === over.id);
      if (targetTask) {
        targetGroup = getStatusDisplay(targetTask).group;
      }
    }

    if (targetGroup) {
      const currentGroup = getStatusDisplay(draggedTask).group;
      if (currentGroup !== targetGroup) {
        // Use task's own configs to find first status in target group
        const configs = getConfigsForTask(draggedTask);
        const sorted = [...configs].sort((a, b) => a.position - b.position);
        const firstInGroup = sorted.find(c => c.group === targetGroup);
        const fallback: Record<TaskStatusGroup, string> = { todo: 'pending', in_progress: 'in_progress', done: 'completed' };
        await handleStatusChange(draggedTask, firstInGroup?.slug || fallback[targetGroup]);
      }
    }
  };

  // Group tasks by status group for kanban
  const tasksByGroup = useMemo(() => {
    const grouped: Record<TaskStatusGroup, Task[]> = {
      todo: [],
      in_progress: [],
      done: [],
    };

    for (const task of tasks) {
      const { group } = getStatusDisplay(task);
      grouped[group].push(task);
    }

    return grouped;
  }, [tasks]);

  // Loading skeleton
  if (loading && tasks.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className={cn(
          'mx-auto w-full',
          isMobileTaskLayout
            ? 'px-4 pt-4'
            : 'container max-w-6xl px-4 py-10 sm:px-6 lg:px-10'
        )}>
          <TaskLoadingSkeleton isMobile={isMobileTaskLayout} />
        </div>
      </div>
    );
  }

  const title = context === 'drive'
    ? `${driveName || drives.find(d => d.id === selectedDriveId)?.name || 'Drive'} Tasks`
    : 'My Tasks';

  const description = context === 'drive'
    ? 'Tasks assigned to you in this drive'
    : filters.driveId
      ? `Your tasks in ${drives.find(d => d.id === filters.driveId)?.name || 'selected drive'}`
      : 'Your tasks across all drives';

  // Note: assigneeFilter === 'all' is included because the default is 'mine',
  // so viewing all tasks is a deviation from the default state that users may want to clear
  const hasActiveFilters = Boolean(
    filters.search ||
    filters.status ||
    filters.priority ||
    (filters.dueDateFilter && filters.dueDateFilter !== 'all') ||
    (context === 'user' && filters.driveId) ||
    filters.assigneeFilter === 'all'
  );

  const clearFilters = () => {
    const nextFilters: ExtendedFilters = {
      assigneeFilter: 'mine',
    };

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }

    setSearchValue('');
    setFilters(nextFilters);
    updateUrl(nextFilters, context === 'drive' ? selectedDriveId : undefined);
  };

  // Count active filters for the badge on mobile filter button
  const activeFilterCount = [
    filters.search,
    filters.status,
    filters.priority,
    filters.dueDateFilter && filters.dueDateFilter !== 'all',
    context === 'user' && filters.driveId,
    filters.assigneeFilter === 'all',
  ].filter(Boolean).length;

  const handleOpenDetailSheet = (task: Task) => {
    setDetailSheetTask(task);
    setDetailSheetOpen(true);
  };

  return (
    <div className="h-full flex flex-col">
      <PullToRefresh
        direction="top"
        onRefresh={handleRefresh}
      >
        <CustomScrollArea className="h-full">
          <div
            className={cn(
              'mx-auto w-full',
              isMobileTaskLayout
                ? 'max-w-none'
                : 'container max-w-6xl px-4 py-10 sm:px-6 lg:px-10'
            )}
          >
            {isMobileTaskLayout ? (
              <>
                {/* Mobile Header - compact */}
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/50">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => router.push(context === 'drive' && selectedDriveId
                        ? `/dashboard/${selectedDriveId}`
                        : '/dashboard'
                      )}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <h1 className="text-base font-semibold truncate flex-1">{title}</h1>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={handleRefresh}
                      disabled={loading}
                    >
                      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    </Button>
                    <TaskFilterButton
                      activeFilterCount={activeFilterCount}
                      onClick={() => setFilterSheetOpen(true)}
                    />
                  </div>

                  {/* Search bar */}
                  <div className="px-3 pb-2.5">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        ref={searchInputRef}
                        placeholder="Search tasks..."
                        value={searchValue}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        className="pl-9 h-9 text-sm bg-muted/50 border-0"
                      />
                    </div>
                  </div>
                </div>

                {/* Error Alert */}
                {error && (
                  <Alert variant="destructive" className="mx-3 mt-3">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {/* Mobile Compact Task List */}
                {tasks.length === 0 ? (
                  <TaskEmptyState
                    context={context}
                    hasDriveSelected={!!selectedDriveId}
                    hasActiveFilters={hasActiveFilters}
                    onClearFilters={clearFilters}
                    isMobile
                  />
                ) : (
                  <div className="divide-y divide-border/50">
                    {tasks.map((task) => (
                      <TaskCompactRow
                        key={task.id}
                        task={task}
                        onToggleComplete={handleToggleComplete}
                        onTap={handleOpenDetailSheet}
                      />
                    ))}
                  </div>
                )}

                {/* Load More */}
                {pagination?.hasMore && (
                  <div className="px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                    <Button
                      onClick={handleLoadMore}
                      variant="outline"
                      disabled={loadingMore}
                      className="h-10 w-full"
                    >
                      {loadingMore ? 'Loading...' : 'Load more'}
                    </Button>
                  </div>
                )}

                {/* Mobile Sheets */}
                <TaskDetailSheet
                  task={detailSheetTask}
                  statusConfigs={detailSheetTask ? getConfigsForTask(detailSheetTask) : []}
                  open={detailSheetOpen}
                  onOpenChange={setDetailSheetOpen}
                  onStatusChange={handleStatusChange}
                  onPriorityChange={handlePriorityChange}
                  onToggleComplete={handleToggleComplete}
                  onMultiAssigneeChange={handleMultiAssigneeChange}
                  onDueDateChange={handleDueDateChange}
                  onSaveTitle={handleSaveTitle}
                  onDelete={handleDeleteTask}
                  onNavigate={handleNavigate}
                />
                <TaskFilterSheet
                  open={filterSheetOpen}
                  onOpenChange={setFilterSheetOpen}
                  context={context}
                  drives={drives}
                  selectedDriveId={selectedDriveId}
                  filters={filters}
                  activeFilterCount={activeFilterCount}
                  statusConfigsByTaskList={statusConfigsByTaskList}
                  onDriveChange={handleDriveChange}
                  onFiltersChange={handleFiltersChange}
                  onClearFilters={clearFilters}
                />
              </>
            ) : (
              <>
                {/* Desktop Header */}
                <div className="mb-6">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push(context === 'drive' && selectedDriveId
                      ? `/dashboard/${selectedDriveId}`
                      : '/dashboard'
                    )}
                    className="mb-3 sm:mb-4"
                  >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h1 className="text-2xl font-bold">{title}</h1>
                      <p className="text-sm text-muted-foreground">{description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* View toggle */}
                      <div className="hidden md:flex items-center bg-muted rounded-md p-0.5">
                        <button
                          onClick={() => setViewMode('table')}
                          className={cn(
                            'p-1.5 rounded transition-colors',
                            viewMode === 'table'
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                          title="Table view"
                          aria-label="Table view"
                        >
                          <LayoutList className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setViewMode('kanban')}
                          className={cn(
                            'p-1.5 rounded transition-colors',
                            viewMode === 'kanban'
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                          title="Kanban view"
                          aria-label="Kanban view"
                        >
                          <Kanban className="h-4 w-4" />
                        </button>
                      </div>
                      <Button
                        onClick={handleRefresh}
                        variant="outline"
                        size="sm"
                        disabled={loading}
                      >
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        <span>Refresh</span>
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Error Alert */}
                {error && (
                  <Alert variant="destructive" className="mb-6">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {/* Desktop Filter Bar */}
                <div className="flex flex-wrap gap-3 mb-6">
                  {/* Search */}
                  <div className="relative flex-1 min-w-[200px] max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      placeholder="Search tasks..."
                      value={searchValue}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  <FilterControls
                    layout="desktop"
                    context={context}
                    drives={drives}
                    selectedDriveId={selectedDriveId}
                    filters={filters}
                    hasActiveFilters={hasActiveFilters}
                    statusConfigsByTaskList={statusConfigsByTaskList}
                    onDriveChange={handleDriveChange}
                    onFiltersChange={handleFiltersChange}
                    onClearFilters={clearFilters}
                  />
                </div>

                {/* Desktop Tasks View */}
                {tasks.length === 0 ? (
                  <TaskEmptyState
                    context={context}
                    hasDriveSelected={!!selectedDriveId}
                    hasActiveFilters={hasActiveFilters}
                    onClearFilters={clearFilters}
                  />
                ) : viewMode === 'kanban' ? (
                  /* Kanban View */
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="flex gap-4 overflow-x-auto pb-4">
                      {STATUS_GROUPS.map((group) => (
                        <KanbanColumn
                          key={group}
                          statusGroup={group}
                          tasks={tasksByGroup[group]}
                          onToggleComplete={handleToggleComplete}
                          onNavigate={handleNavigate}
                          onStartEdit={handleStartEdit}
                          onDelete={handleDeleteTask}
                          editingTaskId={editingTaskId}
                          editingTitle={editingTitle}
                          onEditingTitleChange={setEditingTitle}
                          onSaveTitle={handleSaveTitle}
                          onCancelEdit={() => setEditingTaskId(null)}
                        />
                      ))}
                    </div>
                    <DragOverlay>
                      {activeTask && (
                        <KanbanCard
                          task={activeTask}
                          isDragging
                          onToggleComplete={() => {}}
                          onNavigate={() => {}}
                          onStartEdit={() => {}}
                          onDelete={() => {}}
                          isEditing={false}
                          editingTitle=""
                          onEditingTitleChange={() => {}}
                          onSaveTitle={() => {}}
                          onCancelEdit={() => {}}
                        />
                      )}
                    </DragOverlay>
                  </DndContext>
                ) : (
                  /* Table View */
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10"></TableHead>
                          <TableHead className="min-w-[250px]">Task</TableHead>
                          <TableHead className="w-32">Status</TableHead>
                          <TableHead className="w-28">Priority</TableHead>
                          <TableHead className="w-32">Assignee</TableHead>
                          <TableHead className="w-28">Due Date</TableHead>
                          <TableHead className="w-40">Source</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tasks.map((task) => (
                          <TaskTableRow
                            key={task.id}
                            task={task}
                            statusConfigs={getConfigsForTask(task)}
                            onStatusChange={handleStatusChange}
                            onPriorityChange={handlePriorityChange}
                            onToggleComplete={handleToggleComplete}
                            onMultiAssigneeChange={handleMultiAssigneeChange}
                            onDueDateChange={handleDueDateChange}
                            onStartEdit={handleStartEdit}
                            onSaveTitle={handleSaveTitle}
                            onDelete={handleDeleteTask}
                            onNavigate={handleNavigate}
                            isEditing={editingTaskId === task.id}
                            editingTitle={editingTitle}
                            onEditingTitleChange={setEditingTitle}
                            onCancelEdit={() => setEditingTaskId(null)}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Load More */}
                {pagination?.hasMore && (
                  <div className="flex justify-center pt-6">
                    <Button
                      onClick={handleLoadMore}
                      variant="outline"
                      disabled={loadingMore}
                    >
                      {loadingMore ? 'Loading...' : 'Load more'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </CustomScrollArea>
      </PullToRefresh>

      {/* Stats Footer - desktop only */}
      {!isMobileTaskLayout && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-2 border-t bg-muted/50 text-sm text-muted-foreground">
          <span><strong>{pagination?.total ?? tasks.length}</strong> tasks</span>
          <span className="text-xs sm:text-sm">
            Updated {formatDistanceToNow(lastRefreshTime, { addSuffix: true })}
          </span>
        </div>
      )}
    </div>
  );
}
