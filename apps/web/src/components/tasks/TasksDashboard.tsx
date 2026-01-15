'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { formatDistanceToNow, format, isPast, isToday } from 'date-fns';
import { ArrowLeft, RefreshCw, AlertTriangle, CheckSquare, Clock, AlertCircle, Circle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import type { Task, TaskFilters, Drive, Pagination, TaskStatus, TaskPriority } from './types';

interface TasksDashboardProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
}

const STATUS_CONFIG: Record<TaskStatus, { label: string; icon: typeof CheckSquare; className: string }> = {
  pending: { label: 'Pending', icon: Circle, className: 'text-muted-foreground' },
  in_progress: { label: 'In Progress', icon: Clock, className: 'text-blue-500' },
  completed: { label: 'Completed', icon: CheckSquare, className: 'text-green-500' },
  blocked: { label: 'Blocked', icon: AlertCircle, className: 'text-red-500' },
};

const PRIORITY_CONFIG: Record<TaskPriority, { label: string; className: string }> = {
  low: { label: 'Low', className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  medium: { label: 'Medium', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
  high: { label: 'High', className: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
};

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

  // Filter state from URL params
  const [selectedDriveId, setSelectedDriveId] = useState<string | undefined>(initialDriveId);
  const [filters, setFilters] = useState<TaskFilters>(() => ({
    status: (searchParams.get('status') as TaskStatus) || undefined,
    priority: (searchParams.get('priority') as TaskPriority) || undefined,
    driveId: searchParams.get('driveId') || undefined,
  }));

  // Update URL when filters change
  const updateUrl = useCallback((newFilters: TaskFilters, newDriveId?: string) => {
    const params = new URLSearchParams();

    if (newFilters.status) {
      params.set('status', newFilters.status);
    }
    if (newFilters.priority) {
      params.set('priority', newFilters.priority);
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

  // Handlers
  const handleLoadMore = () => {
    if (pagination?.hasMore) {
      fetchTasks(pagination.offset + pagination.limit, true);
    }
  };

  const handleRefresh = async () => {
    await fetchTasks();
  };

  const handleFiltersChange = (newFilters: Partial<TaskFilters>) => {
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

  // Loading skeleton
  if (loading && tasks.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
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

  // Group tasks by status for better organization
  const tasksByStatus = {
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    pending: tasks.filter(t => t.status === 'pending'),
    blocked: tasks.filter(t => t.status === 'blocked'),
    completed: tasks.filter(t => t.status === 'completed'),
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
        {/* Header */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(context === 'drive' && selectedDriveId
              ? `/dashboard/${selectedDriveId}`
              : '/dashboard'
            )}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <Button
              onClick={handleRefresh}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
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
        <div className="mb-6 flex flex-wrap gap-3">
          {/* Drive Selector (for user context or drive context switching) */}
          <Select
            value={context === 'drive' ? selectedDriveId : (filters.driveId || 'all')}
            onValueChange={(value) => handleDriveChange(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All drives" />
            </SelectTrigger>
            <SelectContent>
              {context === 'user' && <SelectItem value="all">All drives</SelectItem>}
              {drives.map((drive) => (
                <SelectItem key={drive.id} value={drive.id}>
                  {drive.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status Filter */}
          <Select
            value={filters.status || 'all'}
            onValueChange={(value) => handleFiltersChange({ status: value === 'all' ? undefined : value as TaskStatus })}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>

          {/* Priority Filter */}
          <Select
            value={filters.priority || 'all'}
            onValueChange={(value) => handleFiltersChange({ priority: value === 'all' ? undefined : value as TaskPriority })}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Tasks List */}
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
                : 'Tasks assigned to you will appear here'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Render by status groups when no status filter is applied */}
            {!filters.status ? (
              <>
                {tasksByStatus.in_progress.length > 0 && (
                  <TaskSection
                    title="In Progress"
                    tasks={tasksByStatus.in_progress}
                    drives={drives}
                    context={context}
                  />
                )}
                {tasksByStatus.pending.length > 0 && (
                  <TaskSection
                    title="Pending"
                    tasks={tasksByStatus.pending}
                    drives={drives}
                    context={context}
                  />
                )}
                {tasksByStatus.blocked.length > 0 && (
                  <TaskSection
                    title="Blocked"
                    tasks={tasksByStatus.blocked}
                    drives={drives}
                    context={context}
                  />
                )}
                {tasksByStatus.completed.length > 0 && (
                  <TaskSection
                    title="Completed"
                    tasks={tasksByStatus.completed}
                    drives={drives}
                    context={context}
                  />
                )}
              </>
            ) : (
              <TaskSection
                title={STATUS_CONFIG[filters.status]?.label || 'Tasks'}
                tasks={tasks}
                drives={drives}
                context={context}
              />
            )}

            {/* Load More */}
            {pagination?.hasMore && (
              <div className="flex justify-center pt-4">
                <Button
                  onClick={handleLoadMore}
                  variant="outline"
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface TaskSectionProps {
  title: string;
  tasks: Task[];
  drives: Drive[];
  context: 'user' | 'drive';
}

function TaskSection({ title, tasks, drives, context }: TaskSectionProps) {
  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">{title} ({tasks.length})</h2>
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} drives={drives} showDrive={context === 'user'} />
        ))}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  drives: Drive[];
  showDrive: boolean;
}

function TaskCard({ task, drives, showDrive }: TaskCardProps) {
  const statusConfig = STATUS_CONFIG[task.status];
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const StatusIcon = statusConfig.icon;
  const drive = drives.find(d => d.id === task.driveId);

  const isOverdue = task.dueDate && isPast(new Date(task.dueDate)) && task.status !== 'completed';
  const isDueToday = task.dueDate && isToday(new Date(task.dueDate));

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
      <StatusIcon className={cn('h-5 w-5 mt-0.5 flex-shrink-0', statusConfig.className)} />

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={task.pageId && task.driveId ? `/dashboard/${task.driveId}/page/${task.pageId}` : '#'}
              className="font-medium hover:underline line-clamp-1"
            >
              {task.title}
            </Link>

            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              {showDrive && drive && (
                <span className="truncate max-w-[150px]">{drive.name}</span>
              )}
              {task.taskListPageTitle && task.driveId && task.taskListPageId && (
                <>
                  {showDrive && drive && <span>·</span>}
                  <Link
                    href={`/dashboard/${task.driveId}/page/${task.taskListPageId}`}
                    className="truncate max-w-[200px] hover:underline flex items-center gap-1"
                  >
                    {task.taskListPageTitle}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge variant="outline" className={cn('text-xs', priorityConfig.className)}>
              {priorityConfig.label}
            </Badge>
          </div>
        </div>

        {/* Due date and meta info */}
        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          {task.dueDate && (
            <span className={cn(
              'flex items-center gap-1',
              isOverdue && 'text-red-500 font-medium',
              isDueToday && !isOverdue && 'text-orange-500 font-medium'
            )}>
              <Clock className="h-3 w-3" />
              {isOverdue ? 'Overdue: ' : isDueToday ? 'Due today: ' : 'Due: '}
              {format(new Date(task.dueDate), 'MMM d')}
            </span>
          )}
          <span>
            Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
          </span>
        </div>
      </div>
    </div>
  );
}
