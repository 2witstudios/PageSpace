'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/hooks/usePermissions';
import { useEditingStore } from '@/stores/useEditingStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
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
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  GripVertical,
  LayoutList,
  Kanban,
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
import { StatusConfigManager } from './StatusConfigManager';
import {
  TaskItem,
  TaskListData,
  TaskStatusConfig,
  buildStatusConfig,
  getStatusOrder,
  isCompletedStatus,
  PRIORITY_CONFIG,
  TaskHandlers,
} from './task-list-types';

interface TaskListViewProps {
  page: TreePage;
}

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

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

// Sortable row component for drag-and-drop
interface SortableTaskRowProps {
  task: TaskItem;
  canEdit: boolean;
  isCompleted: boolean;
  children: React.ReactNode;
}

function SortableTaskRow({ task, canEdit, isCompleted, children }: SortableTaskRowProps) {
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

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      className={cn(
        'group',
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
}

export default function TaskListView({ page }: TaskListViewProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const viewMode = useLayoutStore((state) => state.taskListViewMode);
  const setViewMode = useLayoutStore((state) => state.setTaskListViewMode);
  const hasLoadedRef = useRef(false);

  // Use centralized socket store for proper authentication
  const { socket, connectionStatus, connect } = useSocketStore();

  // Drag-and-drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Register/unregister editing state for UI refresh protection
  useEffect(() => {
    if (editingTaskId) {
      useEditingStore.getState().startEditing(page.id, 'form', { pageId: page.id, componentName: 'TaskListView' });
    } else {
      useEditingStore.getState().endEditing(page.id);
    }
    return () => useEditingStore.getState().endEditing(page.id);
  }, [editingTaskId, page.id]);

  // Fetch tasks with refresh protection
  // CRITICAL: Only pause AFTER initial load - never block the first fetch
  const { data, error, isLoading } = useSWR<TaskListData>(
    `/api/pages/${page.id}/tasks`,
    fetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => hasLoadedRef.current && isAnyActive,
      onSuccess: () => { hasLoadedRef.current = true; },
      refreshInterval: 300000, // 5 minutes
    }
  );

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

    socket.emit('join_page', page.id);

    // Handle task events (event names match backend broadcast format: task:${operation})
    const handleTaskAdded = () => {
      mutate(`/api/pages/${page.id}/tasks`);
    };

    const handleTaskUpdated = () => {
      mutate(`/api/pages/${page.id}/tasks`);
    };

    const handleTaskDeleted = () => {
      mutate(`/api/pages/${page.id}/tasks`);
    };

    const handleTasksReordered = () => {
      mutate(`/api/pages/${page.id}/tasks`);
    };

    socket.on('task:task_added', handleTaskAdded);
    socket.on('task:task_updated', handleTaskUpdated);
    socket.on('task:task_deleted', handleTaskDeleted);
    socket.on('task:tasks_reordered', handleTasksReordered);

    return () => {
      socket.off('task:task_added', handleTaskAdded);
      socket.off('task:task_updated', handleTaskUpdated);
      socket.off('task:task_deleted', handleTaskDeleted);
      socket.off('task:tasks_reordered', handleTasksReordered);
    };
  }, [socket, connectionStatus, page.id]);

  // Derive dynamic status config from API response
  const statusConfigs: TaskStatusConfig[] = data?.statusConfigs || [];
  const statusConfigMap = buildStatusConfig(statusConfigs);
  const statusOrder = getStatusOrder(statusConfigs);

  // Filter tasks
  const filteredTasks = data?.tasks.filter(task => {
    // Status filter - use group-based completion detection
    const isDone = isCompletedStatus(task.status, statusConfigs);
    if (filter === 'active' && isDone) return false;
    if (filter === 'completed' && !isDone) return false;

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      return (
        task.title.toLowerCase().includes(searchLower) ||
        task.description?.toLowerCase().includes(searchLower)
      );
    }

    return true;
  }) || [];

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
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to create task');
    }
  };

  // Update task status
  const handleStatusChange = async (taskId: string, newStatus: string) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { status: newStatus });
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to update status');
    }
  };

  // Update task priority
  const handlePriorityChange = async (taskId: string, newPriority: string) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { priority: newPriority });
      mutate(`/api/pages/${page.id}/tasks`);
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
      mutate(`/api/pages/${page.id}/tasks`);
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
      mutate(`/api/pages/${page.id}/tasks`);
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
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to update assignee');
    }
  };

  // Update task assignees (multiple)
  const handleMultiAssigneeChange = async (taskId: string, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { assigneeIds });
      mutate(`/api/pages/${page.id}/tasks`);
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
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to update due date');
    }
  };

  // Handle drag end - reorder pages (page position is source of truth)
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
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

    // Calculate new position (between neighbors)
    let newPosition: number;
    if (newIndex === 0) {
      // Moving to first position
      const firstTask = tasks[0];
      newPosition = (firstTask.page?.position ?? firstTask.position) - 1;
    } else if (newIndex === tasks.length - 1) {
      // Moving to last position
      const lastTask = tasks[tasks.length - 1];
      newPosition = (lastTask.page?.position ?? lastTask.position) + 1;
    } else {
      // Moving between two tasks
      const beforeTask = newIndex > oldIndex ? tasks[newIndex] : tasks[newIndex - 1];
      const afterTask = newIndex > oldIndex ? tasks[newIndex + 1] : tasks[newIndex];
      const beforePos = beforeTask.page?.position ?? beforeTask.position;
      const afterPos = afterTask.page?.position ?? afterTask.position;
      newPosition = (beforePos + afterPos) / 2;
    }

    // Optimistic update
    const reorderedTasks = arrayMove(tasks, oldIndex, newIndex);
    mutate(
      `/api/pages/${page.id}/tasks`,
      { ...data, tasks: reorderedTasks },
      false
    );

    try {
      // Call page reorder API (page position is source of truth)
      await patch('/api/pages/reorder', {
        pageId: draggedTask.pageId,
        newParentId: page.id, // Keep same parent
        newPosition,
      });
      // Refetch to get server state
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      // Revert on error
      mutate(`/api/pages/${page.id}/tasks`);
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
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        Failed to load tasks
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
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
              placeholder="Filter tasks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-full sm:w-48"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle (desktop only) */}
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

          {canEdit && (
            <StatusConfigManager
              pageId={page.id}
              statusConfigs={statusConfigs}
              onConfigsChanged={() => mutate(`/api/pages/${page.id}/tasks`)}
            />
          )}

          {canEdit && viewMode === 'table' && (
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                const mobileInput = document.getElementById('new-task-input-mobile');
                const desktopInput = document.getElementById('new-task-input');
                (mobileInput ?? desktopInput)?.focus();
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
          <MobileTaskCard
            key={task.id}
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
            driveId={page.driveId}
            isEditing={editingTaskId === task.id}
            editingTitle={editingTitle}
            onEditingTitleChange={setEditingTitle}
            onCancelEdit={() => setEditingTaskId(null)}
            statusConfigMap={statusConfigMap}
            statusOrder={statusOrder}
            statusConfigs={statusConfigs}
          />
        ))}

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
                            <div className="flex items-center gap-2">
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
                          <MultiAssigneeSelect
                            driveId={page.driveId}
                            assignees={task.assignees || []}
                            onUpdate={(assigneeIds) => handleMultiAssigneeChange(task.id, assigneeIds)}
                            disabled={!canEdit}
                          />
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
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
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
                          </div>
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
            </DndContext>

            {filteredTasks.length === 0 && !canEdit && (
              <div className="text-center py-12 text-muted-foreground">
                No tasks yet
              </div>
            )}
          </>
        )}
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
    </div>
  );
}
