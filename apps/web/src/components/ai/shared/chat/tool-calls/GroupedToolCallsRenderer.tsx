'use client';

import React, { useMemo, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, Loader2, CheckCircle2, XCircle, Clock, ListTodo } from 'lucide-react';
import { ToolCallRenderer } from './ToolCallRenderer';
import { cn } from '@/lib/utils';
import { toTitleCase } from '@/lib/utils/formatters';
import { patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import Link from 'next/link';
import type { Task, TaskList } from '../useAggregatedTasks';
import { getNextTaskStatus } from '../useAggregatedTasks';
import { ExpandableTaskItem } from '../ExpandableTaskItem';

interface ToolCallPart {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface GroupedToolCallsRendererProps {
  toolCalls: ToolCallPart[];
  className?: string;
}

type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'error';

interface ToolCallWithStatus extends ToolCallPart {
  status: ToolStatus;
  index: number;
}

function getToolStatus(state?: string): ToolStatus {
  if (!state) return 'pending';

  switch (state) {
    case 'input-streaming':
    case 'streaming':
      return 'in_progress';
    case 'output-error':
      return 'error';
    case 'done':
    case 'output-available':
      return 'completed';
    case 'input-available':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function getStatusIcon(status: ToolStatus) {
  switch (status) {
    case 'in_progress':
      return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'pending':
      return <Clock className="h-4 w-4 text-gray-400" />;
  }
}

export function GroupedToolCallsRenderer({ toolCalls, className }: GroupedToolCallsRendererProps) {
  // Optimistic state for task status updates
  const [optimisticStatuses, setOptimisticStatuses] = useState<Map<string, Task['status']>>(new Map());

  // Process tool calls with status
  const toolCallsWithStatus = useMemo<ToolCallWithStatus[]>(() => {
    return toolCalls.map((tool, index) => ({
      ...tool,
      status: getToolStatus(tool.state),
      index,
    }));
  }, [toolCalls]);

  // Calculate summary stats
  const summary = useMemo(() => {
    const stats = {
      total: toolCalls.length,
      completed: 0,
      in_progress: 0,
      error: 0,
      pending: 0,
    };

    toolCallsWithStatus.forEach(tool => {
      stats[tool.status]++;
    });

    return stats;
  }, [toolCallsWithStatus, toolCalls.length]);

  // Controlled open state - always starts closed
  const [isOpen, setIsOpen] = useState(false);

  // Find the current active tool (first in_progress or error)
  const activeToolIndex = useMemo(() => {
    return toolCallsWithStatus.findIndex(tool =>
      tool.status === 'in_progress' || tool.status === 'error'
    );
  }, [toolCallsWithStatus]);

  // Format summary text
  const summaryText = useMemo(() => {
    const parts: string[] = [];

    if (summary.completed > 0) {
      parts.push(`${summary.completed} completed`);
    }
    if (summary.in_progress > 0) {
      parts.push(`${summary.in_progress} in progress`);
    }
    if (summary.error > 0) {
      parts.push(`${summary.error} failed`);
    }
    if (summary.pending > 0) {
      parts.push(`${summary.pending} pending`);
    }

    return parts.join(', ');
  }, [summary]);

  // Overall status for the group
  const groupStatus = useMemo<ToolStatus>(() => {
    if (summary.error > 0) return 'error';
    if (summary.in_progress > 0) return 'in_progress';
    if (summary.pending > 0) return 'pending';
    return 'completed';
  }, [summary]);

  // Get tool name for display
  const toolDisplayName = useMemo(() => {
    if (toolCalls.length === 0) return 'tool';
    const toolName = toolCalls[0].toolName || toolCalls[0].type.replace('tool-', '');
    return toTitleCase(toolName);
  }, [toolCalls]);

  // Check if this is a task management group
  const isTaskManagementGroup = useMemo(() => {
    return toolCalls.length > 0 && toolCalls.every(tool => {
      const name = tool.toolName || tool.type?.replace('tool-', '');
      return name === 'update_task';
    });
  }, [toolCalls]);

  // Aggregate tasks from all update_task outputs
  const aggregatedTaskData = useMemo(() => {
    if (!isTaskManagementGroup) return null;

    const taskMap = new Map<string, Task>();
    let taskList: TaskList | null = null;

    for (const tool of toolCalls) {
      if (tool.state !== 'output-available' && tool.state !== 'done') continue;

      try {
        const output = typeof tool.output === 'string'
          ? JSON.parse(tool.output)
          : tool.output;

        if (output?.success && output.tasks) {
          // Track task list metadata
          if (output.taskList) {
            taskList = output.taskList;
          }
          // Update task map with latest data
          for (const task of output.tasks) {
            taskMap.set(task.id, task);
          }
        }
      } catch {
        // Skip malformed output
      }
    }

    // Sort tasks by status priority then position
    const sortedTasks = Array.from(taskMap.values()).sort((a, b) => {
      const statusPriority = { in_progress: 0, pending: 1, blocked: 2, completed: 3 };
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.position - b.position;
    });

    // Calculate progress
    const total = sortedTasks.length;
    const completed = sortedTasks.filter(t => t.status === 'completed').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      tasks: sortedTasks,
      taskList,
      progress: { total, completed, percentage }
    };
  }, [toolCalls, isTaskManagementGroup]);

  // Handle status toggle (click on status icon)
  const handleStatusToggle = async (e: React.MouseEvent, taskId: string, currentStatus: Task['status'], taskListPageId: string | undefined) => {
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

  // Task management group header
  if (isTaskManagementGroup && aggregatedTaskData) {
    const { tasks, taskList, progress } = aggregatedTaskData;

    return (
      <div className={cn('my-1', className)}>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger className="w-full flex items-center justify-between py-1.5 px-2 text-left rounded hover:bg-muted/50 transition-colors group">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="flex-shrink-0">
                <ListTodo className="h-4 w-4 text-primary" />
              </div>
              {taskList?.pageId && taskList?.driveId ? (
                <Link
                  href={`/dashboard/${taskList.driveId}/${taskList.pageId}`}
                  className="font-medium text-sm text-foreground truncate hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {taskList.title || 'Task List'}
                </Link>
              ) : (
                <span className="font-medium text-sm text-foreground truncate">
                  {taskList?.title || 'Task List'}
                </span>
              )}
              <Badge variant="secondary" className="text-xs">
                {progress.completed}/{progress.total}
              </Badge>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="mt-1 rounded-lg bg-background">
              {/* Task list */}
              {tasks.length > 0 && (
                <div className="divide-y divide-border/50 max-h-72 overflow-auto">
                  {tasks.map((task) => {
                    const displayStatus = optimisticStatuses.get(task.id) ?? task.status;

                    return (
                      <ExpandableTaskItem
                        key={task.id}
                        task={task}
                        driveId={taskList?.driveId || ''}
                        taskListPageId={taskList?.pageId || ''}
                        displayStatus={displayStatus}
                        onStatusToggle={(e, taskId, status) => handleStatusToggle(e, taskId, status, taskList?.pageId)}
                        disabled={!taskList?.pageId}
                      />
                    );
                  })}
                </div>
              )}

              {/* Empty state */}
              {tasks.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No tasks
                </div>
              )}

              {/* Footer with summary */}
              <div className="px-3 py-2 border-t text-xs text-muted-foreground flex gap-3 flex-wrap">
                <span>{summary.total} update{summary.total !== 1 ? 's' : ''}</span>
                {progress.completed > 0 && (
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-green-500" />
                    {progress.completed} done
                  </span>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }

  // Default rendering for non-task groups
  return (
    <div className={cn('my-1', className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full flex items-center justify-between py-1.5 px-2 text-left rounded hover:bg-muted/50 transition-colors group">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex-shrink-0">
              {getStatusIcon(groupStatus)}
            </div>
            <span className="font-medium text-sm text-foreground truncate">
              {summary.total} {toolDisplayName} call{summary.total !== 1 ? 's' : ''}
            </span>
            <span className="text-xs text-muted-foreground">
              {summaryText}
            </span>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-0.5 pl-6">
            {toolCallsWithStatus.map((tool, index) => {
              const isActive = index === activeToolIndex;
              return (
                <div
                  key={tool.toolCallId || `tool-${index}`}
                  className={cn(
                    'relative',
                    isActive && 'bg-primary/5 rounded'
                  )}
                >
                  <ToolCallRenderer part={tool} />
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
