'use client';

import React, { useState, useMemo } from 'react';
import { UIMessage } from 'ai';
import {
  ListTodo,
  Clock,
  Circle,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useAggregatedTasks, type Task, getNextTaskStatus } from './chat/useAggregatedTasks';
import { patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { ExpandableTaskItem } from './chat/ExpandableTaskItem';

interface TasksDropdownProps {
  messages: UIMessage[];
}

export function TasksDropdown({ messages }: TasksDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isListOpen, setIsListOpen] = useState(true);
  const [optimisticStatuses, setOptimisticStatuses] = useState<Map<string, Task['status']>>(new Map());

  const { tasks, taskList, hasTaskData, isLoading } = useAggregatedTasks(messages);

  // Calculate stats
  const stats = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, inProgress, pending, blocked, percentage };
  }, [tasks]);

  // Sort tasks by status priority then position
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const statusPriority = { in_progress: 0, pending: 1, blocked: 2, completed: 3 };
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.position - b.position;
    });
  }, [tasks]);

  // Get task list page ID for API calls
  const taskListPageId = taskList?.pageId;

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
      // Clear optimistic entry on success - authoritative data comes from useAggregatedTasks
      setOptimisticStatuses(prev => {
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
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

  // Badge count: show in-progress tasks (or pending if none in progress)
  const badgeCount = stats.inProgress > 0 ? stats.inProgress : (stats.pending > 0 ? stats.pending : 0);

  // Don't render if no task data
  if (!hasTaskData || !taskList) {
    return null;
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          title="View Tasks"
        >
          <ListTodo className="h-4 w-4" />
          {badgeCount > 0 && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-medium">
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <div className="flex flex-col max-h-[28rem] overflow-hidden">
          {/* Header */}
          <Collapsible open={isListOpen} onOpenChange={setIsListOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-between p-3 border-b cursor-pointer hover:bg-muted/50 transition-colors w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                  <span
                    className="font-medium text-sm truncate"
                    title={taskList.title}
                  >
                    {taskList.title}
                  </span>
                  {isLoading && (
                    <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge variant="secondary" className="text-xs">
                    {stats.completed}/{stats.total}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{stats.percentage}%</span>
                  <ChevronDown className={cn(
                    "w-4 h-4 text-muted-foreground transition-transform",
                    isListOpen && "rotate-180"
                  )} />
                </div>
              </button>
            </CollapsibleTrigger>

            {/* Progress bar */}
            <div className="w-full bg-muted h-1">
              <div
                className="bg-primary h-1 transition-all duration-300"
                style={{ width: `${stats.percentage}%` }}
              />
            </div>

            <CollapsibleContent className="flex flex-col min-h-0 flex-1">
              {/* Task list */}
              <ScrollArea className="flex-1 min-h-0">
                <div className="divide-y divide-border/50">
                  {sortedTasks.map((task) => {
                    const displayStatus = optimisticStatuses.get(task.id) ?? task.status;

                    return (
                      <ExpandableTaskItem
                        key={task.id}
                        task={task}
                        driveId={taskList.driveId || ''}
                        taskListPageId={taskListPageId || ''}
                        displayStatus={displayStatus}
                        onStatusToggle={handleStatusToggle}
                        disabled={!taskListPageId}
                      />
                    );
                  })}
                </div>
              </ScrollArea>

              {/* Footer with status summary */}
              {tasks.length > 0 && (
                <div className="px-3 py-2 border-t text-xs text-muted-foreground flex gap-3 flex-wrap flex-shrink-0">
                  {stats.inProgress > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {stats.inProgress} active
                    </span>
                  )}
                  {stats.pending > 0 && (
                    <span className="flex items-center gap-1">
                      <Circle className="w-3 h-3" />
                      {stats.pending} pending
                    </span>
                  )}
                  {stats.blocked > 0 && (
                    <span className="flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {stats.blocked} blocked
                    </span>
                  )}
                </div>
              )}

              {/* Empty state */}
              {tasks.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No tasks yet
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </PopoverContent>
    </Popover>
  );
}
