import React, { useState } from 'react';
import { CheckCircle, ListTodo, Loader2, AlertCircle, ChevronRight, ChevronDown } from 'lucide-react';
import { CompactTodoListMessage } from '../CompactTodoListMessage';

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

interface CompactTaskManagementRendererProps {
  part: ToolPart;
  onTaskUpdate?: (taskId: string, newStatus: 'pending' | 'in_progress' | 'completed' | 'blocked') => void;
}

/**
 * Compact version for sidebar - renders task management tool results as interactive CompactTodoListMessage components
 */
export const CompactTaskManagementRenderer: React.FC<CompactTaskManagementRendererProps> = ({
  part,
  onTaskUpdate
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = part.toolName || part.type?.replace('tool-', '') || '';
  const state = part.state || 'input-streaming';
  const output = part.output as TaskManagementToolOutput | undefined;

  // Get tool icon
  const getToolIcon = () => {
    const iconClass = "h-3 w-3 flex-shrink-0";
    switch (toolName) {
      case 'update_task':
        return <CheckCircle className={iconClass} />;
      default:
        return <ListTodo className={iconClass} />;
    }
  };

  // Get tool display name
  const getToolDisplayName = (): string => {
    switch (toolName) {
      case 'update_task':
        return 'Update Task';
      default:
        return 'Task Management';
    }
  };

  // Get status icon based on state
  const getStatusIcon = () => {
    const iconClass = "h-3 w-3 flex-shrink-0";
    if (state === 'input-streaming' || state === 'input-available') {
      return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
    }
    if (state === 'output-error') {
      return <AlertCircle className={`${iconClass} text-red-500`} />;
    }
    if (!output?.success) {
      return <AlertCircle className={`${iconClass} text-yellow-500`} />;
    }
    return <CheckCircle className={`${iconClass} text-green-500`} />;
  };

  // Get compact summary
  const getCompactSummary = (): string => {
    if (state === 'input-streaming' || state === 'input-available') {
      return 'Running...';
    }
    if (state === 'output-error') {
      return 'Failed';
    }
    if (!output?.success) {
      return 'Failed';
    }
    if (output.tasks?.length) {
      const completed = output.tasks.filter(t => t.status === 'completed').length;
      return `${completed}/${output.tasks.length}`;
    }
    return 'Done';
  };

  const isLoading = state === 'input-streaming' || state === 'input-available';
  const isSuccess = (state === 'output-available' || state === 'done') && output?.success;
  const hasTasks = isSuccess && output.taskList && output.tasks && output.tasks.length > 0;

  return (
    <div className="py-0.5 text-[11px] max-w-full overflow-hidden">
      <button
        onClick={() => !isLoading && setIsExpanded(!isExpanded)}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full overflow-hidden"
        disabled={isLoading}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0" />
        )}
        {getToolIcon()}
        <span className="font-medium truncate flex-1 min-w-0">{getToolDisplayName()}</span>
        {getStatusIcon()}
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
          {getCompactSummary()}
        </span>
      </button>

      {isExpanded && !isLoading && (
        <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[10px] space-y-1 max-w-full overflow-hidden">
          {state === 'output-error' && (
            <div className="text-red-600 dark:text-red-400">
              {part.errorText || 'An error occurred'}
            </div>
          )}

          {!output?.success && state !== 'output-error' && (
            <div className="text-yellow-600 dark:text-yellow-400">
              {output?.message || 'Operation was not successful'}
            </div>
          )}

          {isSuccess && (
            <>
              {output.summary && (
                <div className="text-muted-foreground">
                  {output.summary}
                </div>
              )}
              {output.message && !output.summary && (
                <div className="text-muted-foreground">
                  {output.message}
                </div>
              )}
              {hasTasks && (
                <CompactTodoListMessage
                  tasks={output.tasks!}
                  taskList={output.taskList!}
                  createdAt={output.taskList!.createdAt}
                  onTaskUpdate={onTaskUpdate}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};