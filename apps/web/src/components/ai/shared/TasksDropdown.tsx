'use client';

import React, { useState, useMemo } from 'react';
import { UIMessage } from 'ai';
import {
  ListTodo,
  CheckCircle2,
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
import { useAggregatedTasks, type Task

 } from './chat/useAggregatedTasks';
import { patch } from '@/lib/auth/auth-fetch';

const STATUS_CONFIG = {
  pending: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  completed: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  blocked: { label: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
};

const PRIORITY_CONFIG = {
  low: { label: 'Low', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
  high: { label: 'High', color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
};

const getStatusIcon = (status: Task['status']) => {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-600" />;
    case 'in_progress':
      return <Clock className="w-4 h-4 text-amber-500" />;
    case 'blocked':
      return <AlertCircle className="w-4 h-4 text-red-600" />;
    case 'pending':
    default:
      return <Circle className="w-4 h-4 text-slate-400" />;
  }
};

interface TasksDropdownProps {
  messages: UIMessage[];
}

export function TasksDropdown({ messages }: TasksDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isListOpen, setIsListOpen] = useState(true);

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

  // Handle task status cycle
  const handleTaskClick = async (taskId: string, currentStatus: Task['status']) => {
    const statusCycle: Task['status'][] = ['pending', 'in_progress', 'completed', 'blocked'];
    const currentIndex = statusCycle.indexOf(currentStatus);
    const nextStatus = statusCycle[(currentIndex + 1) % statusCycle.length];

    try {
      await patch(`/api/ai/tasks/${taskId}/status`, { status: nextStatus });
    } catch (error) {
      console.error('Failed to update task status:', error);
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
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex flex-col max-h-96">
          {/* Header */}
          <Collapsible open={isListOpen} onOpenChange={setIsListOpen}>
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 border-b cursor-pointer hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                  <span className="font-medium text-sm truncate">{taskList.title}</span>
                  {isLoading && (
                    <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {stats.completed}/{stats.total}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{stats.percentage}%</span>
                  <ChevronDown className={cn(
                    "w-4 h-4 text-muted-foreground transition-transform",
                    isListOpen && "rotate-180"
                  )} />
                </div>
              </div>
            </CollapsibleTrigger>

            {/* Progress bar */}
            <div className="w-full bg-muted h-1">
              <div
                className="bg-primary h-1 transition-all duration-300"
                style={{ width: `${stats.percentage}%` }}
              />
            </div>

            <CollapsibleContent>
              {/* Task list */}
              <ScrollArea className="max-h-64">
                <div className="divide-y divide-border/50">
                  {sortedTasks.map((task) => {
                    const isCompleted = task.status === 'completed';

                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "flex items-center gap-2 py-2 px-3 hover:bg-muted/40 transition-colors cursor-pointer",
                          isCompleted && "opacity-60"
                        )}
                        onClick={() => handleTaskClick(task.id, task.status)}
                      >
                        {/* Status icon */}
                        <div className="flex-shrink-0">
                          {getStatusIcon(task.status)}
                        </div>

                        {/* Title */}
                        <div className={cn(
                          "flex-1 min-w-0 text-sm truncate",
                          isCompleted && "line-through text-muted-foreground"
                        )}>
                          {task.title}
                        </div>

                        {/* Priority badge (only show high) */}
                        {task.priority === 'high' && (
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] px-1.5 py-0", PRIORITY_CONFIG[task.priority].color)}
                          >
                            {PRIORITY_CONFIG[task.priority].label}
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>

              {/* Footer with status summary */}
              {tasks.length > 0 && (
                <div className="px-3 py-2 border-t text-xs text-muted-foreground flex gap-3 flex-wrap">
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
