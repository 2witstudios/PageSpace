import React, { useState, useMemo } from 'react';
import {
  CheckCircle2,
  Clock,
  Circle,
  AlertCircle,
  ChevronDown,
  Loader2,
  User
} from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { patch } from '@/lib/auth/auth-fetch';
import type { Task, TaskList } from '../useAggregatedTasks';

const PRIORITY_CONFIG = {
  low: { label: 'Low', color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-600 dark:bg-amber-900 dark:text-amber-400' },
  high: { label: 'High', color: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400' },
};

interface TaskManagementRendererProps {
  tasks: Task[];
  taskList: TaskList;
  isLoading?: boolean;
  hasError?: boolean;
  errorMessage?: string;
}

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

const formatDueDate = (dueDate: string | null | undefined): { text: string; isOverdue: boolean; isUrgent: boolean } | null => {
  if (!dueDate) return null;

  const date = new Date(dueDate);
  const now = new Date();
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const text = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return {
    text,
    isOverdue: diffDays < 0,
    isUrgent: diffDays >= 0 && diffDays <= 3,
  };
};

const getInitials = (name: string | null): string => {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2);
};

/**
 * Persistent inline task list for AI chat.
 * Displays aggregated task data with columns for status, title, priority, assignee, and due date.
 */
export const TaskManagementRenderer: React.FC<TaskManagementRendererProps> = ({
  tasks,
  taskList,
  isLoading = false,
  hasError = false,
  errorMessage,
}) => {
  const [isOpen, setIsOpen] = useState(true);

  // Sort tasks by status priority then position
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const statusPriority = { in_progress: 0, pending: 1, blocked: 2, completed: 3 };
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return a.position - b.position;
    });
  }, [tasks]);

  // Calculate progress
  const progress = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percentage };
  }, [tasks]);

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

  return (
    <div className="my-2 mr-2 sm:mr-8">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        {/* Header */}
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between py-2 px-3 rounded-t-lg bg-muted/30 hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
              <span className="font-medium text-sm truncate">{taskList.title}</span>
              {isLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {progress.completed}/{progress.total}
              </Badge>
              <span className="text-xs text-muted-foreground">{progress.percentage}%</span>
              <ChevronDown className={cn(
                "w-4 h-4 text-muted-foreground transition-transform",
                isOpen && "rotate-180"
              )} />
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-muted/50 h-1">
            <div
              className="bg-primary h-1 transition-all duration-300"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="bg-muted/20 rounded-b-lg">
            {/* Error state */}
            {hasError && (
              <div className="px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {errorMessage || 'An error occurred'}
              </div>
            )}

            {/* Task list */}
            <div className="divide-y divide-border/50">
              {sortedTasks.map((task) => {
                const dueInfo = formatDueDate(task.dueDate);
                const isCompleted = task.status === 'completed';

                return (
                  <div
                    key={task.id}
                    className={cn(
                      "flex items-center gap-2 py-1.5 px-3 hover:bg-muted/40 transition-colors cursor-pointer",
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

                    {/* Priority badge (only show high/medium) */}
                    {task.priority !== 'low' && (
                      <Badge
                        variant="outline"
                        className={cn("text-[10px] px-1.5 py-0", PRIORITY_CONFIG[task.priority].color)}
                      >
                        {PRIORITY_CONFIG[task.priority].label}
                      </Badge>
                    )}

                    {/* Assignee avatar */}
                    {task.assignee ? (
                      <Avatar className="w-5 h-5">
                        <AvatarImage src={task.assignee.image || undefined} />
                        <AvatarFallback className="text-[10px]">
                          {getInitials(task.assignee.name)}
                        </AvatarFallback>
                      </Avatar>
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
                        <User className="w-3 h-3 text-muted-foreground" />
                      </div>
                    )}

                    {/* Due date */}
                    {dueInfo && (
                      <span className={cn(
                        "text-xs flex-shrink-0",
                        dueInfo.isOverdue && "text-red-600 dark:text-red-400",
                        dueInfo.isUrgent && !dueInfo.isOverdue && "text-amber-600 dark:text-amber-400",
                        !dueInfo.isOverdue && !dueInfo.isUrgent && "text-muted-foreground"
                      )}>
                        {dueInfo.text}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer with status summary */}
            {tasks.length > 0 && (
              <div className="px-3 py-2 border-t border-border/50 text-xs text-muted-foreground flex gap-3">
                {tasks.filter(t => t.status === 'in_progress').length > 0 && (
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {tasks.filter(t => t.status === 'in_progress').length} in progress
                  </span>
                )}
                {tasks.filter(t => t.status === 'pending').length > 0 && (
                  <span className="flex items-center gap-1">
                    <Circle className="w-3 h-3" />
                    {tasks.filter(t => t.status === 'pending').length} pending
                  </span>
                )}
                {tasks.filter(t => t.status === 'blocked').length > 0 && (
                  <span className="flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {tasks.filter(t => t.status === 'blocked').length} blocked
                  </span>
                )}
              </div>
            )}

            {/* Empty state */}
            {tasks.length === 0 && !isLoading && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                No tasks yet
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
