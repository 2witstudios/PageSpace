import React from 'react';
import { CheckCircle, ListTodo, Loader2, AlertCircle } from 'lucide-react';
import { CompactTodoListMessage } from '@/components/ai/chat/CompactTodoListMessage';

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

interface CompactTaskManagementToolRendererProps {
  part: ToolPart;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
}

/**
 * Compact version for sidebar - renders task management tool results as interactive CompactTodoListMessage components
 */
export const CompactTaskManagementToolRenderer: React.FC<CompactTaskManagementToolRendererProps> = ({
  part,
  onTaskUpdate
}) => {
  const toolName = part.toolName || part.type?.replace('tool-', '') || '';
  const state = part.state || 'input-streaming';
  const output = part.output as TaskManagementToolOutput | undefined;

  // Get tool icon
  const getToolIcon = (toolName: string) => {
    const iconClass = "h-3 w-3";
    switch (toolName) {
      case 'update_task':
        return <CheckCircle className={iconClass} />;
      default:
        return <ListTodo className={iconClass} />;
    }
  };


  // Get tool display name
  const getToolDisplayName = (toolName: string): string => {
    switch (toolName) {
      case 'update_task':
        return 'Update Task';
      default:
        return 'Task Management';
    }
  };

  // Handle different states
  switch (state) {
    case 'input-streaming':
    case 'input-available':
      return (
        <div className="text-xs p-2 bg-primary/10 dark:bg-primary/20 rounded-md mb-1">
          <div className="flex items-center gap-2 text-primary">
            {getToolIcon(toolName)}
            <span className="font-medium">{getToolDisplayName(toolName)}</span>
            <Loader2 className="h-3 w-3 animate-spin ml-auto" />
          </div>
        </div>
      );

    case 'output-error':
      return (
        <div className="text-xs p-2 bg-red-50 dark:bg-red-900/20 rounded-md mb-1">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertCircle className="h-3 w-3" />
            <span className="font-medium">Task Management Error</span>
          </div>
          <div className="text-red-600 dark:text-red-400 mt-1 text-[10px]">
            {part.errorText || 'An error occurred'}
          </div>
        </div>
      );

    case 'output-available':
    case 'done':
      if (!output?.success) {
        return (
          <div className="text-xs p-2 bg-yellow-50 dark:bg-yellow-900/20 rounded-md mb-1">
            <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-300">
              <AlertCircle className="h-3 w-3" />
              <span className="font-medium">Task Operation Failed</span>
            </div>
            <div className="text-yellow-600 dark:text-yellow-400 mt-1 text-[10px]">
              {output?.message || 'Operation was not successful'}
            </div>
          </div>
        );
      }

      // Success case - render CompactTodoListMessage if we have task data
      if (output.taskList && output.tasks) {
        return (
          <div className="mb-1">
            <div className="text-xs p-2 bg-green-50 dark:bg-green-900/20 rounded-md mb-1">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                <CheckCircle className="h-3 w-3" />
                <span className="font-medium">{getToolDisplayName(toolName)} Completed</span>
              </div>
              {output.summary && (
                <div className="text-green-600 dark:text-green-400 mt-1 text-[10px]">
                  {output.summary}
                </div>
              )}
            </div>
            <CompactTodoListMessage
              tasks={output.tasks}
              taskList={output.taskList}
              createdAt={output.taskList.createdAt}
              onTaskUpdate={onTaskUpdate}
            />
          </div>
        );
      }

      // Fallback for operations that don't return full task list data
      return (
        <div className="text-xs p-2 bg-green-50 dark:bg-green-900/20 rounded-md mb-1">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
            <CheckCircle className="h-3 w-3" />
            <span className="font-medium">{getToolDisplayName(toolName)} Completed</span>
          </div>
          {output.summary && (
            <div className="text-green-600 dark:text-green-400 mt-1 text-[10px]">
              {output.summary}
            </div>
          )}
          {output.message && (
            <div className="text-green-600 dark:text-green-400 mt-1 text-[10px]">
              {output.message}
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
};