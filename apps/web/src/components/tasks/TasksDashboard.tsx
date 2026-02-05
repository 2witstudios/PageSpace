'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { formatDistanceToNow, format, isPast, isToday } from 'date-fns';
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  CheckSquare,
  ExternalLink,
  Search,
  LayoutList,
  Kanban,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
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
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { toast } from 'sonner';
import { fetchWithAuth, patch, del } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { useMobile } from '@/hooks/useMobile';
import { useCapacitor } from '@/hooks/useCapacitor';
import { AssigneeSelect } from '@/components/layout/middle-content/page-views/task-list/AssigneeSelect';
import { DueDatePicker } from '@/components/layout/middle-content/page-views/task-list/DueDatePicker';
import {
  STATUS_CONFIG,
  PRIORITY_CONFIG,
  STATUS_ORDER,
  type TaskStatus,
  type TaskPriority,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task, TaskFilters, Drive, Pagination } from './types';
import { TaskMobileCard } from './TaskMobileCard';
import { FilterControls } from './FilterControls';

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

  // Filter state from URL params
  const [selectedDriveId, setSelectedDriveId] = useState<string | undefined>(initialDriveId);
  const [filters, setFilters] = useState<ExtendedFilters>(() => ({
    status: (searchParams.get('status') as TaskStatus) || undefined,
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
        } else {
          setTasks(data.tasks);
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

  // Task update handlers
  const handleStatusChange = async (task: Task, newStatus: string) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, { status: newStatus });
      // Update local state optimistically
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, status: newStatus as TaskStatus } : t
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
    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    await handleStatusChange(task, newStatus);
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

  const handleAssigneeChange = async (task: Task, assigneeId: string | null, agentId: string | null) => {
    if (!task.taskListPageId) return;

    try {
      await patch(`/api/pages/${task.taskListPageId}/tasks/${task.id}`, {
        assigneeId,
        assigneeAgentId: agentId,
      });
      fetchTasks(); // Refetch to get updated assignee data
    } catch {
      toast.error('Failed to update assignee');
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

    // Determine target status
    let targetStatus: TaskStatus | null = null;

    // Check if dropped on a column
    if (STATUS_ORDER.includes(over.id as TaskStatus)) {
      targetStatus = over.id as TaskStatus;
    } else {
      // Check if dropped on a task - find that task's status
      const targetTask = tasks.find(t => t.id === over.id);
      if (targetTask) {
        targetStatus = targetTask.status;
      }
    }

    if (targetStatus && draggedTask.status !== targetStatus) {
      await handleStatusChange(draggedTask, targetStatus);
    }
  };

  // Group tasks by status for kanban
  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      pending: [],
      in_progress: [],
      completed: [],
      blocked: [],
    };

    for (const task of tasks) {
      grouped[task.status].push(task);
    }

    return grouped;
  }, [tasks]);

  // Loading skeleton
  if (loading && tasks.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-6xl">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-96" />
          </div>
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
                ? 'max-w-none px-3 py-4'
                : 'container max-w-6xl px-4 py-10 sm:px-6 lg:px-10'
            )}
          >
            {/* Header */}
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
              <div className={cn(
                'flex flex-col gap-3',
                !isMobileTaskLayout && 'sm:flex-row sm:items-center sm:justify-between'
              )}>
                <div>
                  <h1 className="text-2xl font-bold">{title}</h1>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
                <div className="flex items-center gap-2">
                  {/* View toggle */}
                  {!isMobileTaskLayout && (
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
                  )}
                  <Button
                    onClick={handleRefresh}
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    className={cn(isMobileTaskLayout && 'h-10 px-3')}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                    <span>{isMobileTaskLayout ? 'Sync' : 'Refresh'}</span>
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

            {/* Filter Bar */}
            <div className={cn('mb-6', isMobileTaskLayout ? 'space-y-3' : 'flex flex-wrap gap-3')}>
              {/* Search */}
              <div className={cn('relative', isMobileTaskLayout ? 'w-full' : 'flex-1 min-w-[200px] max-w-sm')}>
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  placeholder="Search tasks..."
                  value={searchValue}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className={cn('pl-9', isMobileTaskLayout && 'h-10 text-base')}
                />
              </div>

              <FilterControls
                layout={isMobileTaskLayout ? 'mobile' : 'desktop'}
                context={context}
                drives={drives}
                selectedDriveId={selectedDriveId}
                filters={filters}
                hasActiveFilters={hasActiveFilters}
                onDriveChange={handleDriveChange}
                onFiltersChange={handleFiltersChange}
                onClearFilters={clearFilters}
              />
            </div>

            {/* Tasks View */}
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium mb-1">
                  {context === 'drive' && !selectedDriveId
                    ? 'Select a drive to view tasks'
                    : 'No tasks found'}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {context === 'drive' && !selectedDriveId
                    ? 'Choose a drive from the dropdown above'
                    : hasActiveFilters
                      ? 'Try adjusting your filters'
                      : 'Tasks assigned to you will appear here'}
                </p>
                {hasActiveFilters && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearFilters}
                    className="mt-4"
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : isMobileTaskLayout ? (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <TaskMobileCard
                    key={task.id}
                    task={task}
                    onStatusChange={handleStatusChange}
                    onPriorityChange={handlePriorityChange}
                    onToggleComplete={handleToggleComplete}
                    onAssigneeChange={handleAssigneeChange}
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
              </div>
            ) : viewMode === 'kanban' ? (
              /* Kanban View */
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                <div className="flex gap-4 overflow-x-auto pb-4">
                  {STATUS_ORDER.map((status) => (
                    <KanbanColumn
                      key={status}
                      status={status}
                      tasks={tasksByStatus[status]}
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
                        onStatusChange={handleStatusChange}
                        onPriorityChange={handlePriorityChange}
                        onToggleComplete={handleToggleComplete}
                        onAssigneeChange={handleAssigneeChange}
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
                  className={cn(isMobileTaskLayout && 'h-10 w-full')}
                >
                  {loadingMore ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        </CustomScrollArea>
      </PullToRefresh>

      {/* Stats Footer */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t bg-muted/50 text-sm text-muted-foreground">
        <span><strong>{pagination?.total ?? tasks.length}</strong> tasks</span>
        <span className="text-xs sm:text-sm">
          Updated {formatDistanceToNow(lastRefreshTime, { addSuffix: true })}
        </span>
      </div>
    </div>
  );
}

// Table Row Component
interface TaskTableRowProps {
  task: Task;
  onStatusChange: (task: Task, status: string) => void;
  onPriorityChange: (task: Task, priority: string) => void;
  onToggleComplete: (task: Task) => void;
  onAssigneeChange: (task: Task, assigneeId: string | null, agentId: string | null) => void;
  onDueDateChange: (task: Task, date: Date | null) => void;
  onStartEdit: (task: Task) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onDelete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
}

function TaskTableRow({
  task,
  onStatusChange,
  onPriorityChange,
  onToggleComplete,
  onAssigneeChange,
  onDueDateChange,
  onStartEdit,
  onSaveTitle,
  onDelete,
  onNavigate,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
}: TaskTableRowProps) {
  const isCompleted = task.status === 'completed';
  const cancelTriggeredRef = useRef(false);

  return (
    <TableRow className={cn('group', isCompleted && 'opacity-60')}>
      {/* Checkbox */}
      <TableCell>
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => onToggleComplete(task)}
        />
      </TableCell>

      {/* Title */}
      <TableCell>
        {isEditing ? (
          <Input
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            onBlur={() => {
              if (cancelTriggeredRef.current) {
                cancelTriggeredRef.current = false;
                return;
              }
              if (editingTitle.trim()) {
                onSaveTitle(task, editingTitle.trim());
              }
              onCancelEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
              if (e.key === 'Escape') {
                cancelTriggeredRef.current = true;
                onCancelEdit();
              }
            }}
            autoFocus
            className="h-8"
          />
        ) : (
          <button
            type="button"
            className={cn(
              'font-medium bg-transparent border-0 p-0 text-left',
              task.pageId && task.driveId
                ? 'cursor-pointer hover:text-primary hover:underline'
                : 'cursor-default',
              isCompleted && 'line-through text-muted-foreground'
            )}
            onClick={task.pageId && task.driveId ? () => onNavigate(task) : undefined}
            disabled={!task.pageId || !task.driveId}
            title={!task.pageId || !task.driveId ? 'No linked page' : undefined}
          >
            {task.title}
          </button>
        )}
      </TableCell>

      {/* Status */}
      <TableCell>
        <Select
          value={task.status}
          onValueChange={(value) => onStatusChange(task, value)}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue>
              <Badge className={cn('text-xs', STATUS_CONFIG[task.status].color)}>
                {STATUS_CONFIG[task.status].label}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {STATUS_ORDER.map((status) => (
              <SelectItem key={status} value={status}>
                <Badge className={cn('text-xs', STATUS_CONFIG[status].color)}>
                  {STATUS_CONFIG[status].label}
                </Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>

      {/* Priority */}
      <TableCell>
        <Select
          value={task.priority}
          onValueChange={(value) => onPriorityChange(task, value)}
        >
          <SelectTrigger className="h-8 w-24">
            <SelectValue>
              <Badge className={cn('text-xs', PRIORITY_CONFIG[task.priority].color)}>
                {PRIORITY_CONFIG[task.priority].label}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(['high', 'medium', 'low'] as TaskPriority[]).map((priority) => (
              <SelectItem key={priority} value={priority}>
                <Badge className={cn('text-xs', PRIORITY_CONFIG[priority].color)}>
                  {PRIORITY_CONFIG[priority].label}
                </Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>

      {/* Assignee */}
      <TableCell>
        {task.driveId && (
          <AssigneeSelect
            driveId={task.driveId}
            currentAssignee={task.assignee}
            currentAssigneeAgent={task.assigneeAgent}
            onSelect={(assigneeId, agentId) => onAssigneeChange(task, assigneeId, agentId)}
          />
        )}
      </TableCell>

      {/* Due Date */}
      <TableCell>
        <DueDatePicker
          currentDate={task.dueDate}
          onSelect={(date) => onDueDateChange(task, date)}
        />
      </TableCell>

      {/* Source Task List */}
      <TableCell>
        {task.taskListPageTitle && task.driveId && task.taskListPageId && (
          <Link
            href={`/dashboard/${task.driveId}/${task.taskListPageId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors max-w-[150px]"
          >
            <span className="truncate">{task.taskListPageTitle}</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
          </Link>
        )}
      </TableCell>

      {/* Actions */}
      <TableCell>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
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
              <DropdownMenuItem onClick={() => onStartEdit(task)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(task)}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}

// Kanban Column Component
interface KanbanColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onToggleComplete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  editingTaskId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onCancelEdit: () => void;
}

function KanbanColumn({
  status,
  tasks,
  onToggleComplete,
  onNavigate,
  onStartEdit,
  onDelete,
  editingTaskId,
  editingTitle,
  onEditingTitleChange,
  onSaveTitle,
  onCancelEdit,
}: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({ id: status });
  const config = STATUS_CONFIG[status];

  return (
    <div className="flex-shrink-0 w-72 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Badge className={cn('text-xs', config.color)}>{config.label}</Badge>
          <span className="text-sm text-muted-foreground">{tasks.length}</span>
        </div>
      </div>

      {/* Cards */}
      <ScrollArea className="flex-1">
        <SortableContext
          id={status}
          items={tasks.map(t => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div
            ref={setNodeRef}
            className="space-y-2 min-h-[100px] p-1 rounded-lg bg-muted/30"
          >
            {tasks.map((task) => (
              <SortableKanbanCard
                key={task.id}
                task={task}
                onToggleComplete={onToggleComplete}
                onNavigate={onNavigate}
                onStartEdit={onStartEdit}
                onDelete={onDelete}
                isEditing={editingTaskId === task.id}
                editingTitle={editingTitle}
                onEditingTitleChange={onEditingTitleChange}
                onSaveTitle={onSaveTitle}
                onCancelEdit={onCancelEdit}
              />
            ))}
            {tasks.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No tasks
              </div>
            )}
          </div>
        </SortableContext>
      </ScrollArea>
    </div>
  );
}

// Sortable Kanban Card
interface SortableKanbanCardProps {
  task: Task;
  onToggleComplete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onCancelEdit: () => void;
}

function SortableKanbanCard(props: SortableKanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <KanbanCard {...props} isDragging={isDragging} />
    </div>
  );
}

// Kanban Card Component
interface KanbanCardProps {
  task: Task;
  isDragging?: boolean;
  onToggleComplete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onCancelEdit: () => void;
}

function KanbanCard({
  task,
  isDragging,
  onToggleComplete,
  onNavigate,
  onStartEdit,
  onDelete,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onSaveTitle,
  onCancelEdit,
}: KanbanCardProps) {
  const isCompleted = task.status === 'completed';
  const cancelTriggeredRef = useRef(false);

  return (
    <Card
      className={cn(
        'group transition-all cursor-grab active:cursor-grabbing',
        isCompleted && 'opacity-60',
        isDragging && 'opacity-50 ring-2 ring-primary'
      )}
    >
      <CardContent className="p-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <Checkbox
            checked={isCompleted}
            onCheckedChange={() => onToggleComplete(task)}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <Input
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={() => {
                  if (cancelTriggeredRef.current) {
                    cancelTriggeredRef.current = false;
                    return;
                  }
                  if (editingTitle.trim()) {
                    onSaveTitle(task, editingTitle.trim());
                  }
                  onCancelEdit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') {
                    cancelTriggeredRef.current = true;
                    onCancelEdit();
                  }
                }}
                autoFocus
                className="h-7 text-sm"
              />
            ) : (
              <button
                type="button"
                className={cn(
                  'text-sm font-medium bg-transparent border-0 p-0 text-left w-full truncate',
                  task.pageId && task.driveId
                    ? 'cursor-pointer hover:text-primary'
                    : 'cursor-default',
                  isCompleted && 'line-through text-muted-foreground'
                )}
                onClick={task.pageId && task.driveId ? () => onNavigate(task) : undefined}
                disabled={!task.pageId || !task.driveId}
                title={!task.pageId || !task.driveId ? 'No linked page' : undefined}
              >
                {task.title}
              </button>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreHorizontal className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {task.pageId && (
                <DropdownMenuItem onClick={() => onNavigate(task)}>
                  <FileText className="h-4 w-4 mr-2" />
                  Open
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onStartEdit(task)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(task)}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2 ml-6">
          <Badge className={cn('text-xs px-1.5 py-0', PRIORITY_CONFIG[task.priority].color)}>
            {PRIORITY_CONFIG[task.priority].label}
          </Badge>

          {/* Assignee */}
          {(task.assignee || task.assigneeAgent) && (
            <span className="text-xs text-muted-foreground">
              {task.assignee?.name || task.assigneeAgent?.title || 'Assigned'}
            </span>
          )}

          {/* Due date */}
          {task.dueDate && (
            <span className={cn(
              'text-xs',
              isPast(new Date(task.dueDate)) && task.status !== 'completed'
                ? 'text-red-500 font-medium'
                : isToday(new Date(task.dueDate))
                  ? 'text-amber-500'
                  : 'text-muted-foreground'
            )}>
              {format(new Date(task.dueDate), 'MMM d')}
            </span>
          )}
        </div>

        {/* Source task list */}
        {task.taskListPageTitle && task.driveId && task.taskListPageId && (
          <div className="mt-2 ml-6">
            <Link
              href={`/dashboard/${task.driveId}/${task.taskListPageId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="truncate max-w-[150px]">{task.taskListPageTitle}</span>
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
