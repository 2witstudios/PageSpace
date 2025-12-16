import { useMemo } from 'react';
import { UIMessage } from 'ai';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  position: number;
  completedAt?: Date;
  dueDate?: string | null;
  pageId?: string; // Linked document page for the task
  assignee?: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  metadata?: {
    notes?: Array<{
      content: string;
      timestamp: string;
    }>;
    estimatedMinutes?: number;
  };
}

// Task status cycle for toggling
export const TASK_STATUS_CYCLE: Task['status'][] = ['pending', 'in_progress', 'completed', 'blocked'];

// Helper to get next status in cycle
export function getNextTaskStatus(currentStatus: Task['status']): Task['status'] {
  const currentIndex = TASK_STATUS_CYCLE.indexOf(currentStatus);
  return TASK_STATUS_CYCLE[(currentIndex + 1) % TASK_STATUS_CYCLE.length];
}

export interface TaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
  pageId?: string; // Task list page
  driveId?: string; // Drive ID for AssigneeSelect
  createdAt?: Date;
  updatedAt?: Date;
}

interface TaskManagementToolOutput {
  success: boolean;
  taskList?: TaskList;
  taskListId?: string;
  title?: string;
  description?: string;
  tasks?: Task[];
  task?: {
    id: string;
    title: string;
    status: string;
  };
  message?: string;
  summary?: string;
}

export interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface MessagePart {
  type: string;
  [key: string]: unknown;
}

interface AggregatedTasksResult {
  tasks: Task[];
  taskList: TaskList | null;
  hasTaskData: boolean;
  isLoading: boolean;
  hasError: boolean;
  errorMessage?: string;
}

/**
 * Aggregates task data from all update_task tool calls in a conversation.
 * Returns the latest task list state and loading status.
 */
export function useAggregatedTasks(messages: UIMessage[]): AggregatedTasksResult {
  return useMemo(() => {
    const taskMap = new Map<string, Task>();
    let latestTaskList: TaskList | null = null;
    let currentTaskListId: string | null = null;
    let isLoading = false;
    let hasError = false;
    let errorMessage: string | undefined;

    // Scan all messages for update_task tool outputs
    for (const message of messages) {
      const parts = (message as { parts?: MessagePart[] }).parts;
      if (!parts) continue;

      for (const part of parts) {
        // Check if this is an update_task tool call
        const toolPart = part as ToolPart;
        if (toolPart.toolName !== 'update_task' && !toolPart.type?.includes('update_task')) {
          continue;
        }

        // Track loading state - reset when completed or errored
        if (toolPart.state === 'input-streaming' || toolPart.state === 'input-available' || toolPart.state === 'streaming') {
          isLoading = true;
        } else if (toolPart.state === 'output-available' || toolPart.state === 'done' || toolPart.state === 'output-error') {
          isLoading = false;
        }

        // Track error state
        if (toolPart.state === 'output-error') {
          hasError = true;
          errorMessage = toolPart.errorText || 'Task update failed';
        }

        // Process successful output
        if (toolPart.state === 'output-available' || toolPart.state === 'done') {
          try {
            const output = typeof toolPart.output === 'string'
              ? JSON.parse(toolPart.output)
              : toolPart.output as TaskManagementToolOutput;

            if (output?.success && output.tasks) {
              // Detect new task list - clear previous tasks when switching lists
              const newTaskListId = output.taskListId || output.taskList?.id;
              if (newTaskListId && newTaskListId !== currentTaskListId) {
                taskMap.clear();
                currentTaskListId = newTaskListId;
              }

              // Update task map with latest data (latest wins)
              for (const task of output.tasks) {
                taskMap.set(task.id, task);
              }

              // Update task list metadata
              if (output.taskList) {
                latestTaskList = output.taskList;
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    // Sort tasks by position
    const tasks = Array.from(taskMap.values()).sort((a, b) => a.position - b.position);

    return {
      tasks,
      taskList: latestTaskList,
      hasTaskData: taskMap.size > 0,
      isLoading,
      hasError,
      errorMessage,
    };
  }, [messages]);
}
