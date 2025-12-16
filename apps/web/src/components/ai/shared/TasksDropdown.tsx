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
  CalendarDays,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useAggregatedTasks, type Task } from './chat/useAggregatedTasks';
import { patch } from '@/lib/auth/auth-fetch';

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

// Smart date formatting for due dates
const formatDueDate = (dateStr: string): { text: string; className: string } => {
  const date = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { text: 'Overdue', className: 'text-red-500' };
  if (diffDays === 0) return { text: 'Today', className: 'text-amber-600 dark:text-amber-400' };
  if (diffDays === 1) return { text: 'Tomorrow', className: 'text-amber-600 dark:text-amber-400' };
  if (diffDays <= 7) return { text: `${diffDays}d`, className: 'text-muted-foreground' };

  return {
    text: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    className: 'text-muted-foreground'
  };
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
      <PopoverContent className="w-96 p-0" align="end">
        <div className="flex flex-col max-h-[28rem]">
          {/* Header */}
          <Collapsible open={isListOpen} onOpenChange={setIsListOpen}>
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 border-b cursor-pointer hover:bg-muted/50 transition-colors">
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
              <ScrollArea className="max-h-72">
                <div className="divide-y divide-border/50">
                  {sortedTasks.map((task) => {
                    const isCompleted = task.status === 'completed';
                    const dueDateInfo = task.dueDate ? formatDueDate(task.dueDate) : null;
                    const hasMetadata = dueDateInfo || task.assignee || task.priority === 'high';

                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "py-2.5 px-3 hover:bg-muted/40 transition-colors cursor-pointer",
                          isCompleted && "opacity-60"
                        )}
                        onClick={() => handleTaskClick(task.id, task.status)}
                      >
                        {/* Row 1: Status + Title */}
                        <div className="flex items-start gap-2">
                          <div className="flex-shrink-0 mt-0.5">
                            {getStatusIcon(task.status)}
                          </div>
                          <span
                            className={cn(
                              "text-sm font-medium leading-tight line-clamp-2",
                              isCompleted && "line-through text-muted-foreground"
                            )}
                            title={task.title}
                          >
                            {task.title}
                          </span>
                        </div>

                        {/* Row 2: Metadata (due date, assignee, priority) */}
                        {hasMetadata && (
                          <div className="flex items-center gap-3 mt-1.5 ml-6 text-xs">
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
