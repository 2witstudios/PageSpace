'use client';

import { memo, type ReactNode } from 'react';
import { format, isPast, isToday, differenceInDays } from 'date-fns';
import { ChevronRight, AlertCircle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { PRIORITY_CONFIG } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task } from './types';
import { getStatusDisplay, getAssigneeText } from './task-helpers';

export interface TaskCompactRowProps {
  task: Task;
  onToggleComplete: (task: Task) => void;
  onTap: (task: Task) => void;
  /**
   * Whether the viewer may change this task. Required rather than defaulting to
   * true: a permission that fails open when a call site forgets it is the wrong
   * kind of default. The dashboard spans many lists and has no single answer,
   * so it passes `true` deliberately.
   */
  canEdit: boolean;
  /**
   * Row-level indicators, rendered between the metadata and the chevron. The
   * task-list page view passes sub-task progress and the agent-trigger bell,
   * neither of which the dashboard has a notion of.
   */
  rowMeta?: ReactNode;
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-400 dark:bg-slate-500',
};

export const TaskCompactRow = memo(function TaskCompactRow({
  task,
  onToggleComplete,
  onTap,
  rowMeta,
  canEdit,
}: TaskCompactRowProps) {
  const isCompleted = getStatusDisplay(task).group === 'done';
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const isOverdue = dueDate && isPast(dueDate) && !isCompleted;
  const isDueToday = dueDate && isToday(dueDate);
  const isDueSoon = dueDate && !isPast(dueDate) && differenceInDays(dueDate, new Date()) <= 3;

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 active:bg-muted/60 transition-colors border-b border-border/50 last:border-b-0',
        isCompleted && 'opacity-50'
      )}
    >
      {/* Checkbox - stops propagation so tapping it doesn't open the sheet */}
      <div
        className="shrink-0"
        onClick={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => onToggleComplete(task)}
          className="h-5 w-5"
          disabled={!canEdit}
          // Names the row it belongs to, matching the table's checkbox
          // (TaskRowCells). Without it the control announces as a bare
          // "checkbox" and a screen reader cannot tell one row's from another's.
          aria-label={`${isCompleted ? 'Reopen' : 'Complete'} ${task.title}`}
        />
      </div>

      {/* Main content - tappable to open detail sheet */}
      <button
        type="button"
        className="flex-1 min-w-0 flex flex-col gap-0.5 text-left bg-transparent border-0 p-0"
        onClick={() => onTap(task)}
      >
        <span
          className={cn(
            'text-sm leading-snug',
            isCompleted
              ? 'line-through text-muted-foreground'
              : 'text-foreground'
          )}
        >
          {task.title}
        </span>

        {/* Compact metadata line */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {/* Priority dot */}
          <span
            className={cn('h-1.5 w-1.5 rounded-full shrink-0', PRIORITY_DOT[task.priority])}
            title={PRIORITY_CONFIG[task.priority].label}
          />

          {/* Due date */}
          {dueDate && (
            <span
              className={cn(
                'flex items-center gap-0.5',
                isOverdue && 'text-red-500 font-medium',
                isDueToday && 'text-amber-600 dark:text-amber-400 font-medium',
                isDueSoon && !isDueToday && 'text-amber-600 dark:text-amber-400'
              )}
            >
              {isOverdue && <AlertCircle className="h-3 w-3" />}
              {format(dueDate, 'MMM d')}
            </span>
          )}

          {/* Assignee names */}
          {(() => {
            const text = getAssigneeText(task);
            return text ? <span className="truncate max-w-[100px]">{text}</span> : null;
          })()}

          {/* Source task list name */}
          {task.taskListPageTitle && (
            <span className="truncate max-w-[80px] text-muted-foreground/70">
              {task.taskListPageTitle}
            </span>
          )}
        </div>
      </button>

      {rowMeta}

      {/* Chevron indicator */}
      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
    </div>
  );
});
