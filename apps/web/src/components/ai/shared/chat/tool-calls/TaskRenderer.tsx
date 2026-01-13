'use client';

import React, { useState, useMemo, memo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ListTodo,
  Loader2,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import type { Task, TaskList, ToolPart } from '../useAggregatedTasks';
import { getNextTaskStatus } from '../useAggregatedTasks';
import { ExpandableTaskItem } from '../ExpandableTaskItem';

interface TaskManagementToolOutput {
  success: boolean;
  action?: 'created' | 'updated';
  taskList?: TaskList;
  tasks?: Task[];
  task?: {
    id: string;
    title: string;
    status: string;
  };
  message?: string;
}

interface TaskRendererProps {
  part: ToolPart;
}

const STATUS_CONFIG = {
  pending: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  completed: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  blocked: { label: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
};

export const TaskRenderer: React.FC<TaskRendererProps> = memo(function TaskRenderer({ part }) {
  const [isOpen, setIsOpen] = useState(false);
  const [optimisticStatuses, setOptimisticStatuses] = useState<Map<string, Task['status']>>(new Map());
  const state = part.state || 'input-streaming';
  const output = part.output as TaskManagementToolOutput | undefined;
  const error = part.errorText;

  // Parse output
  const parsedOutput = useMemo(() => {
    if (!output) return null;
    if (typeof output === 'string') {
      try {
        return JSON.parse(output) as TaskManagementToolOutput;
      } catch {
        return null;
      }
    }
    return output;
  }, [output]);

  // Sort tasks by status priority then position
  const sortedTasks = useMemo(() => {
    if (!parsedOutput?.tasks) return [];
    return [...parsedOutput.tasks].sort((a, b) => {
      const statusPriority = { in_progress: 0, pending: 1, blocked: 2, completed: 3 };
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.position - b.position;
    });
  }, [parsedOutput?.tasks]);

  // Calculate progress
  const progress = useMemo(() => {
    if (!sortedTasks.length) return { total: 0, completed: 0, percentage: 0 };
    const total = sortedTasks.length;
    const completed = sortedTasks.filter(t => t.status === 'completed').length;
    return { total, completed, percentage: Math.round((completed / total) * 100) };
  }, [sortedTasks]);

  // Generate summary text
  const getSummaryText = () => {
    if (state === 'input-streaming' || state === 'streaming' || state === 'input-available') {
      return 'Updating tasks...';
    }
    if (state === 'output-error') {
      return 'Task update failed';
    }
    if (!parsedOutput?.success) {
      return parsedOutput?.message || 'Task operation failed';
    }

    const action = parsedOutput.action || 'updated';
    const taskTitle = parsedOutput.task?.title;

    if (taskTitle) {
      return `${action === 'created' ? 'Created' : 'Updated'} task: "${taskTitle}"`;
    }

    if (parsedOutput.tasks?.length) {
      return `${progress.completed}/${progress.total} tasks completed`;
    }

    return parsedOutput.message || 'Task updated';
  };

  // Get task list page ID for API calls
  const taskListPageId = parsedOutput?.taskList?.pageId;

  // Handle status toggle (click on status icon)
  const handleStatusToggle = async (e: React.MouseEvent, taskId: string, currentStatus: Task['status']) => {
    e.stopPropagation();
    e.preventDefault();

    if (!taskListPageId) {
      toast.error('Cannot update task status');
      return;
    }

    const nextStatus = getNextTaskStatus(currentStatus);

    // Optimistic update
    setOptimisticStatuses(prev => new Map(prev).set(taskId, nextStatus));

    try {
      await patch(`/api/pages/${taskListPageId}/tasks/${taskId}`, { status: nextStatus });
    } catch {
      // Revert optimistic update on error
      setOptimisticStatuses(prev => {
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
      toast.error('Failed to update task status');
    }
  };

  // Get status icon based on state
  const getStatusIcon = () => {
    const iconClass = "h-3 w-3 flex-shrink-0";
    if (state === 'input-streaming' || state === 'streaming' || state === 'input-available') {
      return <Loader2 className={`${iconClass} text-primary animate-spin`} />;
    }
    if (state === 'output-error' || !parsedOutput?.success) {
      return <AlertCircle className={`${iconClass} text-red-500`} />;
    }
    return <CheckCircle className={`${iconClass} text-green-500`} />;
  };

  // Get compact summary for inline display
  const getCompactSummary = (): string => {
    if (state === 'input-streaming' || state === 'streaming' || state === 'input-available') {
      return 'Running...';
    }
    if (state === 'output-error' || !parsedOutput?.success) {
      return 'Failed';
    }
    if (sortedTasks.length > 0) {
      return `${progress.completed}/${progress.total}`;
    }
    return 'Done';
  };

  const hasTasks = sortedTasks.length > 0;
  const taskList = parsedOutput?.taskList;
  const isLoading = state === 'input-streaming' || state === 'streaming' || state === 'input-available';

  return (
    <div className="py-0.5 text-[11px] max-w-full">
      <button
        onClick={() => !isLoading && setIsOpen(!isOpen)}
        className="w-full flex items-center space-x-1.5 text-left hover:bg-muted/30 rounded py-0.5 px-1 transition-colors max-w-full"
        disabled={isLoading}
        aria-expanded={isOpen}
        aria-label="Task management details"
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0" />
        )}
        <ListTodo className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium truncate flex-1 min-w-0">{getSummaryText()}</span>
        {getStatusIcon()}
        <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px] min-w-0">
          {getCompactSummary()}
        </span>
      </button>

      {isOpen && !isLoading && (
        <div className="mt-1 p-1.5 bg-gray-50 dark:bg-gray-800/50 rounded text-[10px] space-y-1 max-w-full break-words">
          {/* Error state */}
          {(state === 'output-error' || !parsedOutput?.success) && (
            <div className="text-red-600 dark:text-red-400">
              {error || parsedOutput?.message || 'Task update failed'}
            </div>
          )}

          {/* Task list header */}
          {parsedOutput?.success && taskList && (
            <div className="pb-1 border-b border-border/50">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                <span className="font-medium">{taskList.title}</span>
              </div>
              {/* Progress bar */}
              <div className="w-full bg-muted h-0.5 mt-1 rounded-full">
                <div
                  className="bg-primary h-0.5 rounded-full transition-all duration-300"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* Task list */}
          {parsedOutput?.success && hasTasks && (
            <div className="divide-y divide-border/30 max-h-40 overflow-auto">
              {sortedTasks.map((task) => {
                const displayStatus = optimisticStatuses.get(task.id) ?? task.status;

                return (
                  <ExpandableTaskItem
                    key={task.id}
                    task={task}
                    driveId={taskList?.driveId || ''}
                    taskListPageId={taskListPageId || ''}
                    displayStatus={displayStatus}
                    onStatusToggle={handleStatusToggle}
                    disabled={!taskListPageId}
                  />
                );
              })}
            </div>
          )}

          {/* Single task info (when no full list) */}
          {parsedOutput?.success && !hasTasks && parsedOutput?.task && (
            <div className="py-1">
              <span className="text-muted-foreground">Task: </span>
              <span className="font-medium">{parsedOutput.task.title}</span>
              <Badge
                variant="outline"
                className={cn(
                  "ml-1.5 text-[9px] px-1 py-0",
                  STATUS_CONFIG[parsedOutput.task.status as Task['status']]?.color
                )}
              >
                {STATUS_CONFIG[parsedOutput.task.status as Task['status']]?.label || parsedOutput.task.status}
              </Badge>
            </div>
          )}

          {/* Message footer */}
          {parsedOutput?.success && parsedOutput?.message && hasTasks && (
            <div className="pt-1 border-t border-border/30 text-muted-foreground">
              {parsedOutput.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
