export type SeedPageType =
  | 'FOLDER'
  | 'DOCUMENT'
  | 'SHEET'
  | 'TASK_LIST'
  | 'CANVAS'
  | 'CHANNEL'
  | 'AI_CHAT';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface SeedTaskTemplate {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: 'self' | 'unassigned';
  dueInDays?: number;
}

export interface SeedTaskListTemplate {
  title: string;
  description: string;
  tasks: SeedTaskTemplate[];
}

export interface SeedNodeTemplate {
  title: string;
  type: SeedPageType;
  content?: string;
  systemPrompt?: string;
  agentDefinition?: string;
  enabledTools?: string[];
  includePageTree?: boolean;
  pageTreeScope?: 'children' | 'drive';
  includeDrivePrompt?: boolean;
  taskList?: SeedTaskListTemplate;
  children?: SeedNodeTemplate[];
}

