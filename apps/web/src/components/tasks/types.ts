/**
 * Types for the Tasks Dashboard components
 */

// Re-export shared types from task-list-types
import type { TaskPriority as SharedTaskPriority, TaskAssigneeData } from '@/components/layout/middle-content/page-views/task-list/task-list-types';

export type TaskStatus = string;
export type TaskPriority = SharedTaskPriority;
export type { TaskAssigneeData };

export interface TaskUser {
  id: string;
  name: string | null;
  image: string | null;
}

export interface TaskAgent {
  id: string;
  title: string;
  type: string;
}

export interface TaskPage {
  id: string;
  title: string;
  isTrashed: boolean;
}

export interface TaskList {
  id: string;
  pageId: string | null;
  title: string;
}

export interface Task {
  id: string;
  taskListId: string;
  userId: string;
  assigneeId: string | null;
  assigneeAgentId: string | null;
  pageId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Relations
  assignee: TaskUser | null;
  assigneeAgent: TaskAgent | null;
  assignees?: TaskAssigneeData[];
  user: TaskUser | null;
  page: TaskPage | null;
  taskList: TaskList | null;
  // Enriched fields
  driveId?: string;
  taskListPageId?: string;
  taskListPageTitle?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  startDate?: Date;
  endDate?: Date;
  driveId?: string;
}

export interface Drive {
  id: string;
  name: string;
  slug: string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
