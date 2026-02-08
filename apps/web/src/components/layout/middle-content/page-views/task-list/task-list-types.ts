// Re-export from shared lib (single source of truth for status config)
import { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';
export { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';

// Shared types and config for task list views

export interface TaskStatusConfig {
  id: string;
  taskListId: string;
  name: string;
  slug: string;
  color: string;
  group: 'todo' | 'in_progress' | 'done';
  position: number;
}

export interface TaskAssigneeData {
  id: string;
  taskId: string;
  userId: string | null;
  agentPageId: string | null;
  user?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  agentPage?: {
    id: string;
    title: string | null;
    type: string;
  } | null;
}

export interface TaskItem {
  id: string;
  taskListId: string;
  userId: string;
  assigneeId: string | null;
  assigneeAgentId: string | null;
  pageId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: 'low' | 'medium' | 'high';
  position: number;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Legacy single-assignee relations (backward compat)
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
  // Multiple assignees (new)
  assignees?: TaskAssigneeData[];
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
  statusConfigs: TaskStatusConfig[];
}

export type TaskPriority = 'low' | 'medium' | 'high';
export type ViewMode = 'table' | 'kanban';

// Build a STATUS_CONFIG-compatible map from custom status configs
export function buildStatusConfig(configs: TaskStatusConfig[]): Record<string, { label: string; color: string; group: TaskStatusGroup }> {
  if (configs.length === 0) return DEFAULT_STATUS_CONFIG;

  const map: Record<string, { label: string; color: string; group: TaskStatusGroup }> = {};
  for (const config of configs) {
    map[config.slug] = { label: config.name, color: config.color, group: config.group };
  }
  return map;
}

// Get ordered status slugs from configs (for kanban columns, status dropdowns)
export function getStatusOrder(configs: TaskStatusConfig[]): string[] {
  if (configs.length === 0) return ['pending', 'in_progress', 'blocked', 'completed'];
  return [...configs].sort((a, b) => a.position - b.position).map(c => c.slug);
}

// Determine if a status slug represents a "done" state
export function isCompletedStatus(slug: string, configs: TaskStatusConfig[]): boolean {
  if (configs.length === 0) return slug === 'completed';
  const config = configs.find(c => c.slug === slug);
  return config?.group === 'done';
}

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string }> = {
  low: { label: 'Low', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
  high: { label: 'High', color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
};

// Backward-compatible aliases
export type TaskStatus = string;
export const STATUS_CONFIG = DEFAULT_STATUS_CONFIG;
export const STATUS_ORDER: string[] = ['pending', 'in_progress', 'blocked', 'completed'];

// Task handlers interface for shared components
export interface TaskHandlers {
  onToggleComplete: (task: TaskItem) => void;
  onStatusChange: (taskId: string, status: string) => void;
  onPriorityChange: (taskId: string, priority: string) => void;
  onAssigneeChange: (taskId: string, assigneeId: string | null, agentId: string | null) => void;
  onMultiAssigneeChange?: (taskId: string, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  onDueDateChange: (taskId: string, date: Date | null) => void;
  onSaveTitle: (taskId: string, title: string) => void;
  onDelete: (taskId: string) => void;
  onNavigate: (task: TaskItem) => void;
  onStartEdit: (task: TaskItem) => void;
}
