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
  userId: string;
  assigneeId: string | null;
  assigneeAgentId: string | null;
  pageId: string | null;
  title: string;
  status: string;
  priority: 'low' | 'medium' | 'high';
  /** Mirror of the linked page's `pages.position` — the single ordering rail (#2143). */
  position: number;
  dueDate: string | null;
  metadata?: Record<string, unknown> | null;
  // activeTriggerCount is the canonical UI source for trigger presence (live join in
  // /api/pages/[pageId]/tasks). The DB row also carries metadata.hasTrigger/triggerTypes
  // written by recomputeTaskTriggerMetadata, but no UI path reads them.
  activeTriggerCount?: number;
  hasContent?: boolean;
  subTaskCount?: number;
  subTaskCompletedCount?: number;
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
    type: string;
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
  hasMore: boolean;
}

export type TaskPriority = 'low' | 'medium' | 'high';

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

export const canExpandTask = (task: Pick<TaskItem, 'hasContent' | 'subTaskCount' | 'pageId'>): boolean =>
  !!task.pageId && (!!task.hasContent || (task.subTaskCount ?? 0) > 0);

// Backward-compatible aliases
export type TaskStatus = string;
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
  onConfigureTriggers?: (task: TaskItem) => void;
}

/**
 * Which list a task belongs to, alongside the task itself.
 *
 * Every task write goes to `/api/pages/{listPageId}/tasks/{taskId}`, where
 * `listPageId` is the page of the list CONTAINING the task — not the task's own
 * page. At the top level that is always the viewed page, which is why the
 * handlers hard-coded it. Nested rows belong to their parent task's list, so
 * the list id has to travel with the task id or a sub-task's PATCH goes to the
 * root list and 404s on the parent-child check.
 */
export interface TaskLocation {
  readonly listPageId: string;
  readonly taskId: string;
}

/**
 * The same handler set, but addressed by TaskLocation. This is what TaskListView
 * implements; `bindTaskHandlersToList` narrows it back down for the surfaces
 * that only ever render top-level tasks.
 */
export interface LocatedTaskHandlers {
  onToggleComplete: (loc: TaskLocation, task: TaskItem) => void;
  onStatusChange: (loc: TaskLocation, status: string) => void;
  onPriorityChange: (loc: TaskLocation, priority: string) => void;
  onAssigneeChange: (loc: TaskLocation, assigneeId: string | null, agentId: string | null) => void;
  onMultiAssigneeChange?: (loc: TaskLocation, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  onDueDateChange: (loc: TaskLocation, date: Date | null) => void;
  onSaveTitle: (loc: TaskLocation, title: string) => void;
  onDelete: (loc: TaskLocation) => void;
  onNavigate: (task: TaskItem) => void;
  onStartEdit: (task: TaskItem) => void;
  onConfigureTriggers?: (task: TaskItem) => void;
}

/**
 * Adapt located handlers to the flat `TaskHandlers` shape by fixing the list.
 *
 * Kanban and the mobile card list only ever render tasks of the viewed list, so
 * they keep their existing prop contract instead of being churned through the
 * whole tree refactor.
 */
export const bindTaskHandlersToList = (
  h: LocatedTaskHandlers,
  listPageId: string,
): TaskHandlers => ({
  onToggleComplete: (task) => h.onToggleComplete({ listPageId, taskId: task.id }, task),
  onStatusChange: (taskId, status) => h.onStatusChange({ listPageId, taskId }, status),
  onPriorityChange: (taskId, priority) => h.onPriorityChange({ listPageId, taskId }, priority),
  onAssigneeChange: (taskId, assigneeId, agentId) =>
    h.onAssigneeChange({ listPageId, taskId }, assigneeId, agentId),
  ...(h.onMultiAssigneeChange && {
    onMultiAssigneeChange: (taskId: string, assigneeIds: { type: 'user' | 'agent'; id: string }[]) =>
      h.onMultiAssigneeChange!({ listPageId, taskId }, assigneeIds),
  }),
  onDueDateChange: (taskId, date) => h.onDueDateChange({ listPageId, taskId }, date),
  onSaveTitle: (taskId, title) => h.onSaveTitle({ listPageId, taskId }, title),
  onDelete: (taskId) => h.onDelete({ listPageId, taskId }),
  onNavigate: h.onNavigate,
  onStartEdit: h.onStartEdit,
  ...(h.onConfigureTriggers && { onConfigureTriggers: h.onConfigureTriggers }),
});
