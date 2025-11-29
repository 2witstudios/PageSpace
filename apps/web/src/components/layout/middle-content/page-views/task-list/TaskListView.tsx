'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import { io, Socket } from 'socket.io-client';
import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '@/hooks/use-auth';
import { usePermissions } from '@/hooks/use-permissions';
import { useEditingStore } from '@/stores/useEditingStore';
import { TreePage } from '@/hooks/usePageTree';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import { getCookieValue } from '@/lib/utils/get-cookie-value';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
  Calendar,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssigneeSelect } from './AssigneeSelect';
import { DueDatePicker } from './DueDatePicker';

interface TaskItem {
  id: string;
  taskListId: string;
  userId: string;
  assigneeId: string | null;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  position: number;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assignee?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  user?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
}

interface TaskListData {
  taskList: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    updatedAt: string;
  };
  tasks: TaskItem[];
}

interface TaskListViewProps {
  page: TreePage;
}

const STATUS_CONFIG = {
  pending: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  completed: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  blocked: { label: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
};

const PRIORITY_CONFIG = {
  low: { label: 'Low', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
  high: { label: 'High', color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
};

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

export default function TaskListView({ page }: TaskListViewProps) {
  const { user } = useAuth();
  const { permissions } = usePermissions(page.id);
  const canEdit = permissions?.canEdit || false;
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const socketRef = useRef<Socket | null>(null);

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
  const { data, error, isLoading } = useSWR<TaskListData>(
    `/api/pages/${page.id}/tasks`,
    fetcher,
    {
      revalidateOnFocus: false,
      isPaused: () => isAnyActive,
      refreshInterval: 300000, // 5 minutes
    }
  );

  // Socket connection for real-time updates
  useEffect(() => {
    if (!user) return;

    const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
    if (!socketUrl) return;

    const socket = io(socketUrl, {
      auth: {
        token: getCookieValue('accessToken'),
      },
    });
    socketRef.current = socket;

    socket.emit('join_page', page.id);

    // Handle task events
    socket.on('task_created', () => {
      mutate(`/api/pages/${page.id}/tasks`);
    });

    socket.on('task_updated', () => {
      mutate(`/api/pages/${page.id}/tasks`);
    });

    socket.on('task_deleted', () => {
      mutate(`/api/pages/${page.id}/tasks`);
    });

    socket.on('tasks_reordered', () => {
      mutate(`/api/pages/${page.id}/tasks`);
    });

    return () => {
      socket.disconnect();
    };
  }, [page.id, user]);

  // Filter tasks
  const filteredTasks = data?.tasks.filter(task => {
    // Status filter
    if (filter === 'active' && task.status === 'completed') return false;
    if (filter === 'completed' && task.status !== 'completed') return false;

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

  // Create new task
  const handleCreateTask = async () => {
    if (!newTaskTitle.trim() || !canEdit) return;

    try {
      await post(`/api/pages/${page.id}/tasks`, {
        title: newTaskTitle.trim(),
      });
      setNewTaskTitle('');
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

  // Toggle task completion
  const handleToggleComplete = async (task: TaskItem) => {
    if (!canEdit) return;

    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    await handleStatusChange(task.id, newStatus);
  };

  // Start editing title
  const handleStartEdit = (task: TaskItem) => {
    if (!canEdit) return;
    setEditingTaskId(task.id);
    setEditingTitle(task.title);
  };

  // Save edited title
  const handleSaveEdit = async () => {
    if (!editingTaskId || !editingTitle.trim()) {
      setEditingTaskId(null);
      return;
    }

    try {
      await patch(`/api/pages/${page.id}/tasks/${editingTaskId}`, {
        title: editingTitle.trim(),
      });
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to update task');
    }
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

  // Update task assignee
  const handleAssigneeChange = async (taskId: string, assigneeId: string | null) => {
    if (!canEdit) return;

    try {
      await patch(`/api/pages/${page.id}/tasks/${taskId}`, { assigneeId });
      mutate(`/api/pages/${page.id}/tasks`);
    } catch {
      toast.error('Failed to update assignee');
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

  // Format due date
  const formatDueDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    if (diffDays < 0) {
      return { text: formatted, className: 'text-red-600 font-medium' };
    } else if (diffDays <= 3) {
      return { text: formatted, className: 'text-amber-600' };
    }
    return { text: formatted, className: 'text-muted-foreground' };
  };

  // Stats
  const stats = {
    total: data?.tasks.length || 0,
    completed: data?.tasks.filter(t => t.status === 'completed').length || 0,
    inProgress: data?.tasks.filter(t => t.status === 'in_progress').length || 0,
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
      <div className="flex items-center justify-between px-4 py-3 border-b bg-background">
        <div className="flex items-center gap-2">
          {/* Filter tabs */}
          <div className="flex items-center bg-muted rounded-md p-0.5">
            {(['all', 'active', 'completed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded transition-colors',
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
              className="pl-9 w-48"
            />
          </div>
        </div>

        {canEdit && (
          <Button size="sm" onClick={() => document.getElementById('new-task-input')?.focus()}>
            <Plus className="h-4 w-4 mr-1" />
            New Task
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead className="min-w-[300px]">Task</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-24">Priority</TableHead>
              <TableHead className="w-32">Assignee</TableHead>
              <TableHead className="w-28">Due Date</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTasks.map((task) => (
              <TableRow
                key={task.id}
                className={cn(
                  'group',
                  task.status === 'completed' && 'opacity-60'
                )}
              >
                {/* Checkbox */}
                <TableCell>
                  <Checkbox
                    checked={task.status === 'completed'}
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
                    <span
                      className={cn(
                        'cursor-pointer hover:text-primary',
                        task.status === 'completed' && 'line-through'
                      )}
                      onClick={() => handleStartEdit(task)}
                    >
                      {task.title}
                    </span>
                  )}
                </TableCell>

                {/* Status */}
                <TableCell>
                  <Select
                    value={task.status}
                    onValueChange={(value) => handleStatusChange(task.id, value)}
                    disabled={!canEdit}
                  >
                    <SelectTrigger className="h-8 w-28">
                      <SelectValue>
                        <Badge className={cn('text-xs', STATUS_CONFIG[task.status].color)}>
                          {STATUS_CONFIG[task.status].label}
                        </Badge>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(STATUS_CONFIG).map(([key, { label, color }]) => (
                        <SelectItem key={key} value={key}>
                          <Badge className={cn('text-xs', color)}>{label}</Badge>
                        </SelectItem>
                      ))}
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
                    <SelectTrigger className="h-8 w-20">
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

                {/* Assignee */}
                <TableCell>
                  <AssigneeSelect
                    driveId={page.driveId}
                    currentAssignee={task.assignee}
                    onSelect={(assigneeId) => handleAssigneeChange(task.id, assigneeId)}
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
                        <DropdownMenuItem onClick={() => handleStartEdit(task)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDeleteTask(task.id)}
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
            ))}

            {/* New task row */}
            {canEdit && (
              <TableRow>
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
            )}
          </TableBody>
        </Table>

        {filteredTasks.length === 0 && !canEdit && (
          <div className="text-center py-12 text-muted-foreground">
            No tasks yet
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/50 text-sm text-muted-foreground">
        <div className="flex gap-4">
          <span><strong>{stats.total}</strong> tasks</span>
          <span><strong>{stats.inProgress}</strong> in progress</span>
          <span><strong>{stats.completed}</strong> completed</span>
        </div>
        <span>
          Last updated: {data?.taskList.updatedAt
            ? formatDistanceToNow(new Date(data.taskList.updatedAt), { addSuffix: true })
            : 'never'}
        </span>
      </div>
    </div>
  );
}
