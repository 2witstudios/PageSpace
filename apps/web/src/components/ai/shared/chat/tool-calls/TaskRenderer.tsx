'use client';

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ListTodo,
  Loader2,
  AlertCircle,
  CalendarDays,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import Link from 'next/link';
import type { Task, TaskList, ToolPart } from '../useAggregatedTasks';
import { getNextTaskStatus } from '../useAggregatedTasks';
import { formatDueDate, getTaskStatusIcon } from '../task-utils';

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

export const TaskRenderer: React.FC<TaskRendererProps> = ({ part }) => {
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

  // Loading state
  if (state === 'input-streaming' || state === 'streaming' || state === 'input-available') {
    return (
      <div className="my-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListTodo className="h-4 w-4" />
          <span>Updating tasks...</span>
          <Loader2 className="h-3 w-3 animate-spin ml-auto" />
        </div>
      </div>
    );
  }

  // Error state
  if (state === 'output-error' || (parsedOutput && !parsedOutput.success)) {
    return (
      <div className="my-2 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3">
        <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="h-4 w-4" />
          <span>{error || parsedOutput?.message || 'Task update failed'}</span>
        </div>
      </div>
    );
  }

  // Success state - collapsible
  const hasTasks = sortedTasks.length > 0;
  const taskList = parsedOutput?.taskList;

  return (
    <div className="my-2">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="w-full flex items-center justify-between rounded-lg border bg-muted/30 p-3 cursor-pointer hover:bg-muted/50 transition-colors text-left">
            <div className="flex items-center gap-2 text-sm">
              <ListTodo className="h-4 w-4 text-primary" />
              <span className="font-medium">{getSummaryText()}</span>
            </div>
            <div className="flex items-center gap-2">
              {hasTasks && (
                <Badge variant="secondary" className="text-xs">
                  {progress.completed}/{progress.total}
                </Badge>
              )}
              <ChevronDown className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                isOpen && "rotate-180"
              )} />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-1 rounded-lg border bg-background">
            {/* Task list header */}
            {taskList && (
              <div className="px-3 py-2 border-b">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                  <span className="font-medium text-sm">{taskList.title}</span>
                </div>
                {/* Progress bar */}
                <div className="w-full bg-muted h-1 mt-2 rounded-full">
                  <div
                    className="bg-primary h-1 rounded-full transition-all duration-300"
                    style={{ width: `${progress.percentage}%` }}
                  />
                </div>
              </div>
            )}

            {/* Task list */}
            {hasTasks && (
              <div className="divide-y divide-border/50 max-h-56 overflow-auto">
                {sortedTasks.map((task) => {
                  const displayStatus = optimisticStatuses.get(task.id) ?? task.status;
                  const isCompleted = displayStatus === 'completed';
                  const dueDateInfo = task.dueDate ? formatDueDate(task.dueDate) : null;
                  const hasMetadata = dueDateInfo || task.assignee || task.priority === 'high';

                  return (
                    <div
                      key={task.id}
                      className={cn(
                        "py-2.5 px-3 hover:bg-muted/40 transition-colors",
                        isCompleted && "opacity-60"
                      )}
                    >
                      {/* Row 1: Status + Title */}
                      <div className="flex items-start gap-2">
                        {/* Status icon - clickable to toggle status */}
                        <button
                          type="button"
                          onClick={(e) => handleStatusToggle(e, task.id, displayStatus)}
                          className="flex-shrink-0 mt-0.5 hover:opacity-70 transition-opacity cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!taskListPageId}
                          title={taskListPageId ? `Click to change status` : 'Status toggle unavailable'}
                        >
                          {getTaskStatusIcon(displayStatus)}
                        </button>
                        {/* Title - link to task's document page */}
                        {task.pageId ? (
                          <Link
                            href={`/pages/${task.pageId}`}
                            className={cn(
                              "text-sm font-medium leading-tight line-clamp-2 hover:underline",
                              isCompleted && "line-through text-muted-foreground"
                            )}
                            title={task.title}
                          >
                            {task.title}
                          </Link>
                        ) : (
                          <span
                            className={cn(
                              "text-sm font-medium leading-tight line-clamp-2",
                              isCompleted && "line-through text-muted-foreground"
                            )}
                            title={task.title}
                          >
                            {task.title}
                          </span>
                        )}
                      </div>

                      {/* Row 2: Metadata (due date, assignee, priority) */}
                      {hasMetadata && (
                        <div className="flex items-center gap-3 mt-1.5 ml-5 text-xs">
                          {dueDateInfo && (
                            <span className={cn("flex items-center gap-1", dueDateInfo.className)}>
                              <CalendarDays className="w-3 h-3" />
                              {dueDateInfo.text}
                            </span>
                          )}
                          {task.assignee && (
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              <Avatar className="w-4 h-4">
                                <AvatarImage src={task.assignee.image || undefined} />
                                <AvatarFallback className="text-[8px]">
                                  {task.assignee.name?.[0]?.toUpperCase() || '?'}
                                </AvatarFallback>
                              </Avatar>
                              <span className="truncate max-w-[80px]">{task.assignee.name}</span>
                            </span>
                          )}
                          {task.priority === 'high' && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 bg-red-50 text-red-600 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800"
                            >
                              High
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Single task info (when no full list) */}
            {!hasTasks && parsedOutput?.task && (
              <div className="px-3 py-2 text-sm">
                <span className="text-muted-foreground">Task: </span>
                <span className="font-medium">{parsedOutput.task.title}</span>
                <Badge
                  variant="outline"
                  className={cn(
                    "ml-2 text-[10px] px-1.5 py-0",
                    STATUS_CONFIG[parsedOutput.task.status as Task['status']]?.color
                  )}
                >
                  {STATUS_CONFIG[parsedOutput.task.status as Task['status']]?.label || parsedOutput.task.status}
                </Badge>
              </div>
            )}

            {/* Message footer */}
            {parsedOutput?.message && hasTasks && (
              <div className="px-3 py-2 border-t text-xs text-muted-foreground">
                {parsedOutput.message}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
