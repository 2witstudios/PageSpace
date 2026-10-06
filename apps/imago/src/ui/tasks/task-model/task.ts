// Imago's task model, and the apps/web shapes it is built from.
//
// The *Response types mirror what the task route handlers actually return
// (apps/web/src/app/api/pages/[pageId]/tasks/**/route.ts and the drive pages
// route in ls mode): they are read from those handlers, not invented. Nothing
// here imports @pagespace/db, so the browser bundle never pulls in drizzle.

/** Which of a list's statuses count as not started, under way, or done. */
export type StatusGroup = 'todo' | 'in_progress' | 'done';

export type Priority = 'low' | 'medium' | 'high';

/** One row of task_status_configs, as GET /tasks and GET /tasks/statuses return it. */
export type TaskStatusConfigResponse = {
  readonly id: string;
  readonly taskListId: string;
  readonly name: string;
  readonly slug: string;
  readonly color: string;
  readonly group: StatusGroup;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type UserRef = { readonly id: string; readonly name: string | null; readonly image: string | null };
type AgentRef = { readonly id: string; readonly title: string | null; readonly type: string };

/** One task_assignees row: a person or an agent page, never both. */
export type TaskAssigneeResponse = {
  readonly id: string;
  readonly taskId: string;
  readonly userId: string | null;
  readonly agentPageId: string | null;
  readonly user?: UserRef | null;
  readonly agentPage?: AgentRef | null;
};

/** A task as GET /api/pages/[pageId]/tasks enriches it. */
export type TaskItemResponse = {
  readonly id: string;
  readonly userId: string;
  /** Legacy single assignee, kept in sync with the first user in `assignees`. */
  readonly assigneeId: string | null;
  readonly assigneeAgentId: string | null;
  /** The task's own TASK_LIST page: it owns the title and holds the subtasks. */
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly priority: Priority;
  /** pages.position of the task's page: the one ordering rail. */
  readonly position: number;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assignee?: UserRef | null;
  readonly assigneeAgent?: AgentRef | null;
  readonly assignees?: readonly TaskAssigneeResponse[];
  readonly activeTriggerCount?: number;
  readonly hasContent?: boolean;
  /** Direct, untrashed subtasks; completed means completedAt is set. */
  readonly subTaskCount?: number;
  readonly subTaskCompletedCount?: number;
};

/** GET /api/pages/[pageId]/tasks. */
export type TaskListResponse = {
  readonly taskList: {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
    readonly updatedAt: string;
  };
  readonly tasks: readonly TaskItemResponse[];
  readonly statusConfigs: readonly TaskStatusConfigResponse[];
  readonly hasMore: boolean;
};

/** GET /api/pages/[pageId]/tasks/statuses. */
export type TaskStatusesResponse = {
  readonly statusConfigs: readonly TaskStatusConfigResponse[];
};

/** One page of GET /api/drives/[driveId]/pages?ls=true. */
export type DrivePageLsEntry = {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly hasChildren: boolean;
  /** The page is a task's own page, not a list someone made. */
  readonly isTaskLinked: boolean;
};

/** GET /api/drives/[driveId]/pages?ls=true. */
export type DrivePagesLsResponse = {
  readonly mode: 'ls';
  readonly pages: readonly DrivePageLsEntry[];
};

/** One of GET /api/drives/[driveId]/assignees: a drive member, or an agent page the viewer can see. */
export type AssignableResponse = {
  readonly id: string;
  readonly type: 'user' | 'agent';
  readonly name: string;
  readonly image: string | null;
  readonly agentTitle?: string;
};

/** GET /api/drives/[driveId]/assignees. */
export type AssignablesResponse = {
  readonly assignees: readonly AssignableResponse[];
};

/** One ancestor in GET /api/pages/[pageId]/breadcrumbs, top of the drive first, the page itself last. */
export type BreadcrumbResponse = {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly parentId: string | null;
};

/** The part of GET /api/pages/[pageId] a task's description reads: its page's content. */
export type PageContentResponse = {
  readonly id: string;
  readonly content: string | null;
};

// ---------------------------------------------------------------------------
// The model views read.

/** One of a list's own statuses. */
export type TaskStatus = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  /** The group, not the slug, decides whether a task is done. */
  readonly group: StatusGroup;
  readonly position: number;
};

/** A person or an agent on a task. */
export type Assignee = {
  readonly type: 'user' | 'agent';
  readonly id: string;
  /** The person's name or the agent page's title; empty when unknown. */
  readonly name: string;
};

/** A task, and the subtasks under it once they are loaded. */
export type Task = {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  /** A slug from the statuses of the list that holds the task. */
  readonly status: string;
  readonly priority: Priority;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly assignees: readonly Assignee[];
  readonly position: number;
  readonly hasContent: boolean;
  readonly subTaskCount: number;
  readonly subTaskCompletedCount: number;
  readonly updatedAt: string;
  /** The task's own list; null until loaded, and for a task with no subtasks. */
  readonly subtasks: TaskList | null;
};

/**
 * A list of tasks: a TASK_LIST page someone made, or a task's own page holding
 * its subtasks. Every list has its own statuses, and writes to its tasks are
 * addressed to its page.
 */
export type TaskList = {
  readonly pageId: string;
  readonly title: string;
  readonly statuses: readonly TaskStatus[];
  readonly tasks: readonly Task[];
  /** The server had more tasks than were loaded. */
  readonly hasMore: boolean;
};

/** A drive's task list, as the list pane names it. */
export type TaskListSummary = {
  readonly pageId: string;
  readonly title: string;
};
