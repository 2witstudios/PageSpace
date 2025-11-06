# Task Management User Guide

## Overview

PageSpace's Human Task Management System allows you to create, assign, track, and collaborate on work items within your workspace. Tasks are first-class pages that integrate seamlessly with your existing page hierarchy, permissions, and collaboration features.

## Creating Tasks

### Create a New Task

There are several ways to create a task:

1. **From the Sidebar**: Click the "+" button and select "Task"
2. **From a Folder**: Navigate to a folder and create a new task inside it
3. **Via API**: Use the `/api/pages` endpoint with `type: "TASK"`

### Task Properties

When creating a task, you can specify:

- **Title**: A clear, descriptive name for the task
- **Description**: Detailed information about what needs to be done (stored in `content`)
- **Assignee**: The team member responsible for completing the task
- **Priority**: low, medium, high, or urgent
- **Status**: pending, in_progress, completed, blocked, or cancelled
- **Due Date**: When the task should be completed
- **Start Date**: When work on the task should begin
- **Estimated Hours**: How long the task is expected to take
- **Labels**: Custom tags for organizing and filtering tasks

## Task Statuses

Tasks can be in one of five states:

- **Pending**: Task has been created but work hasn't started
- **In Progress**: Task is actively being worked on
- **Completed**: Task has been finished successfully
- **Blocked**: Task cannot proceed due to dependencies or issues
- **Cancelled**: Task is no longer needed

## Task Priorities

Tasks have four priority levels:

- **Low**: Can be addressed when time permits
- **Medium**: Standard priority for most tasks
- **High**: Should be prioritized over medium tasks
- **Urgent**: Requires immediate attention

## Assigning Tasks

### Assigning to Team Members

Only users who are members of the drive can be assigned tasks. To assign a task:

1. Open the task page
2. Select an assignee from the dropdown (shows only drive members)
3. The assignee will be notified of the assignment

### Unassigning Tasks

To unassign a task, simply set the assignee to "Unassigned" or `null` via the API.

## Viewing Tasks

### Task Detail View

When you open a task page, you'll see:

- Task title and description
- Current status and priority badges
- Assignee and creator information
- Due date and start date (if set)
- Time tracking (estimated and actual hours)
- Labels
- Quick status update buttons
- Creation and update timestamps

### Querying Tasks

Use the `/api/tasks` endpoint to query tasks with various filters:

```typescript
// Get all pending tasks in a drive
GET /api/tasks?driveId=drive123&status=pending

// Get tasks assigned to a specific user
GET /api/tasks?assigneeId=user456

// Get high priority tasks due before a date
GET /api/tasks?priority=high&dueBefore=2024-12-31T23:59:59Z

// Get tasks with pagination
GET /api/tasks?limit=50&offset=0
```

## Updating Tasks

### Update Task Status

Click one of the status buttons on the task page or use the API:

```typescript
PATCH /api/tasks/[taskId]
{
  "status": "in_progress"
}
```

When a task is marked as completed, the `completedAt` timestamp is automatically set.

### Update Task Metadata

You can update any task field via the API:

```typescript
PATCH /api/tasks/[taskId]
{
  "assigneeId": "user789",
  "priority": "high",
  "dueDate": "2024-12-31T23:59:59Z",
  "estimatedHours": 4.5,
  "labels": ["frontend", "bug-fix"]
}
```

## Permissions

Tasks inherit PageSpace's standard permission model:

- **View**: Can see task details
- **Edit**: Can update task fields, change status, add comments
- **Share**: Can assign the task to others
- **Delete**: Can delete the task

Special cases:
- Task creators (assigners) always have edit permission
- Task assignees always have edit permission
- Only drive owners and admins can create tasks

## Time Tracking

Tasks support optional time tracking:

- **Estimated Hours**: Set when creating the task to indicate expected effort
- **Actual Hours**: Update as work progresses to track actual time spent

This helps with project planning and identifying estimation accuracy over time.

## Labels and Custom Fields

### Labels

Labels are simple string tags you can use to categorize tasks:

```typescript
{
  "labels": ["frontend", "bug", "priority"]
}
```

Use labels to:
- Categorize tasks by type (bug, feature, documentation)
- Tag by system area (frontend, backend, database)
- Mark special attributes (urgent, needs-review, blocked)

### Custom Fields

The `customFields` object allows you to store additional metadata:

```typescript
{
  "customFields": {
    "sprint": "Sprint 12",
    "storyPoints": 5,
    "reviewer": "user123"
  }
}
```

## Best Practices

### Task Naming

- Use clear, action-oriented titles
- Start with a verb (e.g., "Fix login bug", "Update pricing page")
- Keep titles concise but descriptive

### Task Descriptions

- Provide enough context for someone else to understand the task
- Include acceptance criteria
- Link to relevant documentation or pages
- Break down complex tasks into steps

### Using Priorities

- Reserve "Urgent" for true emergencies
- Use "High" for time-sensitive work
- Default to "Medium" for standard tasks
- Use "Low" for nice-to-have improvements

### Status Updates

- Update task status as work progresses
- Move to "Blocked" immediately when stuck
- Add comments explaining blocks or delays
- Mark completed promptly to maintain accurate dashboards

### Due Dates

- Set realistic due dates based on estimates
- Account for dependencies and other commitments
- Update due dates if circumstances change
- Use due dates to prioritize work, not as hard deadlines

## Task Hierarchy

Tasks can have child tasks, allowing you to:

- Break large tasks into subtasks
- Track progress hierarchically
- Attach files and documents to tasks

Child tasks are created the same way as regular tasks, but with a `parentId` pointing to the parent task.

## Integration with Workspace

### Task Pages in Folders

Tasks appear in the page hierarchy like any other page:

```
📁 Project X
  📄 Requirements Document
  ✓ Design mockups (Task - In Progress)
  ✓ Implement backend API (Task - Completed)
  ✓ Write tests (Task - Pending)
  📄 Deployment Guide
```

### Permissions from Drive

Tasks inherit permissions from their parent folder and drive:

- If you can view a folder, you can view its tasks
- If you can edit a folder, you can edit its tasks
- Drive admins have full access to all tasks

### Real-time Updates

Task changes are broadcast in real-time to all users viewing the task or dashboard, ensuring everyone sees the latest status.

## Task Workflows

### Example: Bug Fix Workflow

1. Create task: "Fix login redirect issue"
2. Set priority: High
3. Assign to: Developer
4. Set status: Pending
5. Developer moves to: In Progress
6. Developer updates actual hours as they work
7. Developer completes fix, sets status: Completed
8. QA reviews and closes task

### Example: Feature Development

1. Create parent task: "Add dark mode support"
2. Create subtasks:
   - "Design dark mode color scheme"
   - "Implement dark mode toggle"
   - "Update all components for dark mode"
   - "Test dark mode across browsers"
3. Assign subtasks to team members
4. Set due dates based on project timeline
5. Track progress as subtasks complete
6. Mark parent task complete when all subtasks done

## API Reference

### Create Task

```typescript
POST /api/pages
{
  "title": "Task title",
  "type": "TASK",
  "driveId": "drive123",
  "parentId": "folder456",
  "content": "Task description",
  "assigneeId": "user789",
  "priority": "high",
  "dueDate": "2024-12-31T23:59:59Z"
}
```

### Query Tasks

```typescript
GET /api/tasks?driveId=drive123&status=pending&assigneeId=user789
```

### Get Task Details

```typescript
GET /api/tasks/[taskId]
```

### Update Task

```typescript
PATCH /api/tasks/[taskId]
{
  "status": "completed",
  "actualHours": 6.5
}
```

## Future Enhancements

Planned features for future releases:

- Task boards (Kanban view)
- Task dashboards ("My Tasks", "Team Tasks")
- Task dependencies (blocking relationships)
- Task comments and activity feed
- Email notifications
- Task templates
- Recurring tasks
- Time tracking automation
- Gantt chart view
- Mobile app support

## Support

For questions or issues:

- Check the [Architecture Documentation](../2.0-architecture/)
- Review the [Implementation Plan](../3.0-guides-and-tools/human-task-management-implementation.md)
- File an issue on GitHub
- Contact your workspace administrator
