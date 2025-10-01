import React from 'react';
import { CheckCircle } from 'lucide-react';
import { TodoListMessage } from './TodoListMessage';

interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  position: number;
  completedAt?: Date;
  metadata?: {
    notes?: Array<{
      content: string;
      timestamp: string;
    }>;
    estimatedMinutes?: number;
  };
}

interface TaskList {
  id: string;
  title: string;
  description?: string;
  status: string;
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

interface ToolPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface TaskManagementToolRendererProps {
  part: ToolPart;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
}

/**
 * Renders task management tool results as interactive TodoListMessage components
 * Handles create_task_list, update_task_status, add_task, get_task_list, resume_task_list
 */
export const TaskManagementToolRenderer: React.FC<TaskManagementToolRendererProps> = ({
  part,
  onTaskUpdate
}) => {
  const toolName = part.toolName || part.type?.replace('tool-', '') || '';
  const state = part.state || 'input-streaming';
  const output = part.output as TaskManagementToolOutput | undefined;

  // Handle different states
  switch (state) {
    case 'input-streaming':
      return (
        <div className="mb-4">
          <div className="bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-lg p-4">
            <div className="animate-pulse">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-4 h-4 bg-primary rounded-full animate-spin"></div>
                <div className="h-4 bg-primary/30 dark:bg-primary/50 rounded w-1/3"></div>
              </div>
              <div className="text-sm text-primary">
                Preparing {getToolDisplayName(toolName)}...
              </div>
            </div>
          </div>
        </div>
      );

    case 'input-available':
      return (
        <div className="mb-4">
          <div className="bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-lg p-4">
            <div className="animate-pulse">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-4 h-4 bg-primary rounded-full animate-spin"></div>
                <div className="font-medium text-primary">
                  {getToolDisplayName(toolName)}
                </div>
              </div>
              <div className="text-sm text-primary">
                Processing task management operation...
              </div>
            </div>
          </div>
        </div>
      );

    case 'output-error':
      return (
        <div className="mb-4">
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <div className="text-red-800 dark:text-red-200 font-medium mb-2">
              Task Management Error
            </div>
            <div className="text-sm text-red-600 dark:text-red-400">
              {part.errorText || 'An error occurred while processing the task management operation'}
            </div>
          </div>
        </div>
      );

    case 'output-available':
      if (!output?.success) {
        return (
          <div className="mb-4">
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <div className="text-yellow-800 dark:text-yellow-200 font-medium mb-2">
                Task Operation Failed
              </div>
              <div className="text-sm text-yellow-600 dark:text-yellow-400">
                {output?.message || 'The task management operation was not successful'}
              </div>
            </div>
          </div>
        );
      }

      // Success case - render TodoListMessage if we have task data
      if (output.taskList && output.tasks) {
        return (
          <TodoListMessage
            tasks={output.tasks}
            taskList={output.taskList}
            createdAt={output.taskList.createdAt}
            onTaskUpdate={onTaskUpdate}
          />
        );
      }

      // Fallback for operations that don't return full task list data
      return (
        <div className="mb-4">
          <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="text-green-800 dark:text-green-200 font-medium mb-2 flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              {getToolDisplayName(toolName)} Completed
            </div>
            {output.summary && (
              <div className="text-sm text-green-600 dark:text-green-400 mb-2">
                {output.summary}
              </div>
            )}
            {output.message && (
              <div className="text-sm text-green-600 dark:text-green-400">
                {output.message}
              </div>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
};

function getToolDisplayName(toolName: string): string {
  switch (toolName) {
    case 'create_task_list':
      return 'Create Task List';
    case 'update_task_status':
      return 'Update Task Status';
    case 'add_task':
      return 'Add Task';
    case 'get_task_list':
      return 'Get Task List';
    case 'resume_task_list':
      return 'Resume Task List';
    case 'add_task_note':
      return 'Add Task Note';
    default:
      return 'Task Management';
  }
}