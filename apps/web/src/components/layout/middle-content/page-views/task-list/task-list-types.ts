// Shared types and config for task list views

export interface TaskItem {
  id: string;
  taskListId: string;
  userId: string;
  assigneeId: string | null;
  assigneeAgentId: string | null;
  pageId: string | null;
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
  assigneeAgent?: {
    id: string;
    title: string | null;
    type: string;
  } | null;
  user?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  page?: {
    id: string;
    isTrashed: boolean;
    position: number;
  } | null;
}

export interface TaskListData {
  taskList: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    updatedAt: string;
  };
  tasks: TaskItem[];
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';
export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string }> = {
  pending: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  completed: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  blocked: { label: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
};

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string }> = {
  low: { label: 'Low', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
  high: { label: 'High', color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
};

// Column order for kanban view
export const STATUS_ORDER: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'completed'];

// Task handlers interface for shared components
export interface TaskHandlers {
  onToggleComplete: (task: TaskItem) => void;
  onStatusChange: (taskId: string, status: string) => void;
  onPriorityChange: (taskId: string, priority: string) => void;
  onAssigneeChange: (taskId: string, assigneeId: string | null, agentId: string | null) => void;
  onDueDateChange: (taskId: string, date: Date | null) => void;
  onSaveTitle: (taskId: string, title: string) => void;
  onDelete: (taskId: string) => void;
  onNavigate: (task: TaskItem) => void;
  onStartEdit: (task: TaskItem) => void;
}
