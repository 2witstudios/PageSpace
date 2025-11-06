# Human Task Management System - Implementation Plan

## Overview

Human Task Management in PageSpace is implemented as a new TASK page type, allowing teams to create, assign, track, and collaborate on work items within their workspace. Tasks are first-class pages that inherit all page capabilities (permissions, hierarchy, real-time sync, comments, attachments) while adding task-specific features.

## Architecture

### 1. Database Schema

#### Task Metadata Table
New table `taskMetadata` linked to pages table:

```typescript
export const taskMetadata = pgTable('task_metadata', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }).unique(),

  // Assignment
  assigneeId: text('assigneeId').references(() => users.id),  // null = unassigned
  assignerId: text('assignerId').notNull().references(() => users.id),

  // Status & Priority
  status: text('status', {
    enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled']
  }).default('pending').notNull(),
  priority: text('priority', {
    enum: ['low', 'medium', 'high', 'urgent']
  }).default('medium').notNull(),

  // Dates
  dueDate: timestamp('dueDate', { mode: 'date' }),
  startDate: timestamp('startDate', { mode: 'date' }),
  completedAt: timestamp('completedAt', { mode: 'date' }),

  // Time Tracking (optional)
  estimatedHours: real('estimatedHours'),
  actualHours: real('actualHours'),

  // Additional metadata
  labels: jsonb('labels').$type<string[]>().default([]),
  customFields: jsonb('customFields').$type<Record<string, unknown>>().default({}),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
});

// Index for efficient queries
export const taskMetadataIndexes = {
  assigneeIdx: index('task_metadata_assignee_idx').on(taskMetadata.assigneeId),
  statusIdx: index('task_metadata_status_idx').on(taskMetadata.status),
  dueDateIdx: index('task_metadata_due_date_idx').on(taskMetadata.dueDate),
  priorityIdx: index('task_metadata_priority_idx').on(taskMetadata.priority),
};
```

#### Task Dependencies Table
For tracking task dependencies:

```typescript
export const taskDependencies = pgTable('task_dependencies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskId: text('taskId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('dependsOnTaskId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  dependencyType: text('dependencyType', {
    enum: ['blocks', 'blocked_by', 'relates_to']
  }).default('blocks').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
});
```

#### Task Comments
Reuse existing `chatMessages` table with `messageType: 'task_comment'`

#### Task Attachments
Use existing file pages with parent-child relationship

### 2. Page Type Configuration

Add TASK to `packages/lib/src/enums.ts`:

```typescript
export enum PageType {
  FOLDER = 'FOLDER',
  DOCUMENT = 'DOCUMENT',
  CHANNEL = 'CHANNEL',
  AI_CHAT = 'AI_CHAT',
  CANVAS = 'CANVAS',
  FILE = 'FILE',
  SHEET = 'SHEET',
  TASK = 'TASK',  // NEW
}
```

Configure in `packages/lib/src/page-types.config.ts`:

```typescript
[PageType.TASK]: {
  displayName: 'Task',
  description: 'Track work items with assignments, due dates, and status',
  emoji: '✓',
  icon: CheckSquare,
  capabilities: {
    canHaveChildren: true,        // Tasks can have subtasks or attachments
    canAcceptUploads: true,       // File attachments
    canBeSearched: true,
    canBeFavorited: true,
    canBeMentioned: true,
    canBeTagged: true,
    supportsRealtime: true,       // Live updates
    supportsAI: false,            // Not an AI conversation
    supportsComments: true,       // Task comments
    supportsVersioning: false,
    hasCustomLayout: true,        // Custom task view
  },
  defaultContent: () => ({
    title: 'New Task',
    content: '',
  }),
  allowedChildTypes: [PageType.FILE, PageType.TASK],  // Subtasks
  layoutViewType: 'task' as const,
}
```

### 3. API Routes

#### Core Task Operations

**POST /api/pages** (extend existing)
- When `type: 'TASK'`, also create taskMetadata record
- Validate assigneeId exists and has drive access

**PATCH /api/pages/[pageId]** (extend existing)
- When page is TASK type, update taskMetadata if task fields provided
- Broadcast task update events

**GET /api/tasks**
```typescript
// Query tasks with filters
// ?driveId=xxx&assigneeId=xxx&status=xxx&priority=xxx&dueBefore=xxx
// Returns paginated task list with metadata
```

**GET /api/tasks/dashboard**
```typescript
// Returns dashboard data:
// - myTasks (assigned to current user)
// - assignedByMe (created by current user)
// - upcomingDueDates
// - blockedTasks
// - recentlyCompleted
```

**PATCH /api/tasks/[taskId]/assign**
```typescript
// Assign/reassign task
{
  assigneeId: string | null;  // null = unassign
}
```

**PATCH /api/tasks/[taskId]/status**
```typescript
// Update task status
{
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  completedAt?: Date;  // auto-set on completed
}
```

**POST /api/tasks/[taskId]/dependencies**
```typescript
// Add task dependency
{
  dependsOnTaskId: string;
  dependencyType: 'blocks' | 'blocked_by' | 'relates_to';
}
```

**POST /api/tasks/[taskId]/comments**
```typescript
// Add comment to task (creates chatMessage with messageType: 'task_comment')
{
  content: string;
}
```

### 4. Real-time Events

Extend `apps/web/src/lib/socket-utils.ts`:

```typescript
export type TaskEventType =
  | 'task:created'
  | 'task:updated'
  | 'task:assigned'
  | 'task:status_changed'
  | 'task:completed'
  | 'task:commented'
  | 'task:dependency_added';

export interface TaskEventPayload {
  type: TaskEventType;
  taskId: string;
  driveId: string;
  userId: string;
  data: {
    assigneeId?: string;
    assignerId?: string;
    status?: string;
    priority?: string;
    previousStatus?: string;
    comment?: string;
  };
}

export async function broadcastTaskEvent(payload: TaskEventPayload) {
  // Broadcast to drive channel
  await broadcastToChannel(`drive:${payload.driveId}:tasks`, 'task:event', payload);

  // Broadcast to assignee if present
  if (payload.data.assigneeId) {
    await broadcastToChannel(`user:${payload.data.assigneeId}:tasks`, 'task:event', payload);
  }
}
```

### 5. UI Components

#### Component Structure

```
apps/web/src/components/tasks/
├── TaskPage.tsx              # Main task detail view
├── TaskBoard.tsx             # Kanban board view
├── TaskList.tsx              # List view
├── TaskCard.tsx              # Card component
├── TaskForm.tsx              # Create/edit form
├── TaskFilters.tsx           # Filter controls
├── TaskDashboard.tsx         # Dashboard view
├── TaskStatusBadge.tsx       # Status indicator
├── TaskPriorityBadge.tsx     # Priority indicator
├── TaskAssigneeAvatar.tsx    # Assignee display
├── TaskDueDateDisplay.tsx    # Due date with warning
├── TaskComments.tsx          # Comment thread
└── TaskDependencyGraph.tsx   # Dependency visualization
```

#### Key Component Features

**TaskPage.tsx**
- Full task details view
- Editable fields (title, description, assignee, status, priority, due date)
- Comment section at bottom
- Dependency list
- Activity history
- File attachments

**TaskBoard.tsx**
- Kanban columns by status (Pending, In Progress, Completed, Blocked)
- Drag-and-drop to change status
- Filters at top (assignee, priority, labels)
- Create new task button

**TaskDashboard.tsx**
- Personal task overview
- Sections: My Tasks, Assigned By Me, Overdue, Due Soon
- Quick filters and search
- Summary statistics

### 6. Permissions Integration

Tasks inherit page permissions from the page system:

- **View**: Can see task details
- **Edit**: Can update task fields, add comments
- **Share**: Can assign task to others
- **Delete**: Can delete task

Additional validation:
- Can only assign tasks to users with view access to the task's drive
- Task creator (assignerId) always has edit permission
- Assignee always has edit permission (can update status, add comments)

### 7. Notification System

Create notifications for:
- Task assigned to you
- Task status changed (if you're assignee or creator)
- Due date approaching (1 day, 1 hour before)
- Task completed (notify creator)
- Comment added (notify assignee and creator)
- Dependency blocked (notify assignee)

Use existing notification infrastructure or extend.

### 8. Search & Filtering

Extend search to include tasks:
- Search by title, description
- Filter by status, priority, assignee, labels, due date
- Sort by due date, priority, created date, updated date

Add to `apps/web/src/lib/ai/tools/search-tools.ts`:

```typescript
export const searchTasks = tool({
  description: 'Search for tasks with filters',
  parameters: z.object({
    query: z.string().optional(),
    driveId: z.string().optional(),
    assigneeId: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    dueBefore: z.string().optional(),
    dueAfter: z.string().optional(),
  }),
  execute: async (params) => {
    // Query tasks with filters
  },
});
```

## Implementation Phases

### Phase 1: Core Infrastructure (This PR)
- ✅ Database schema (taskMetadata, taskDependencies)
- ✅ Database migration
- ✅ Add TASK page type to enum and config
- ✅ Core API routes (create, update, query tasks)
- ✅ Basic task page UI component

### Phase 2: Task Views
- Task board (kanban) component
- Task list component
- Task dashboard
- Filters and search

### Phase 3: Collaboration Features
- Task comments
- File attachments
- Task dependencies
- Activity history

### Phase 4: Advanced Features
- Notifications
- Time tracking
- Custom fields
- Task templates
- Recurring tasks

## Migration Strategy

1. Create migration with taskMetadata and taskDependencies tables
2. Add indexes for performance
3. No data migration needed (new feature)
4. Rollback plan: Drop new tables

## Testing Strategy

1. Unit tests for task API routes
2. Integration tests for task creation/update flow
3. Permission tests (can only assign to drive members)
4. Real-time sync tests
5. UI component tests

## Documentation Updates

1. User guide: Creating and managing tasks
2. API documentation: Task endpoints
3. Developer guide: Extending task system
4. Architecture docs: Task page type

## Security Considerations

1. Validate assigneeId is a drive member
2. Check permissions before task operations
3. Sanitize task descriptions (prevent XSS)
4. Rate limit task creation
5. Audit log for task assignments

## Performance Considerations

1. Index on assigneeId, status, dueDate for fast queries
2. Paginate task lists
3. Cache task counts for dashboard
4. Debounce real-time updates
5. Lazy load task comments/history

## Future Enhancements

1. Task templates
2. Recurring tasks
3. Task automation (e.g., auto-assign based on rules)
4. Gantt chart view
5. Task burndown charts
6. Email integration (create tasks from email)
7. Calendar integration
8. Mobile app support
9. Task import/export
10. Integration with external tools (Jira, Asana, etc.)
