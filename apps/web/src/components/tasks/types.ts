/**
 * Types for the Tasks Dashboard components
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';

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
