'use client';

import React, { memo } from 'react';
import { Tag, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TaskStatusRendererProps {
  name: string;
  slug?: string;
  group?: 'todo' | 'in_progress' | 'done' | string;
  /** Tailwind color classes assigned to the status. */
  color?: string;
  message?: string;
  className?: string;
}

const GROUP_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

/**
 * TaskStatusRenderer - Result of create_task_status. Shows the new status chip,
 * its slug (for use in update_task) and its semantic group.
 */
export const TaskStatusRenderer: React.FC<TaskStatusRendererProps> = memo(function TaskStatusRenderer({
  name,
  slug,
  group,
  color,
  message,
  className,
}) {
  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b">
        <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">New status</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-green-700 dark:text-green-400 shrink-0">
          <CheckCircle className="h-3 w-3" />
          Created
        </span>
      </div>

      <div className="p-3 flex items-center gap-3 flex-wrap">
        <span
          className={cn(
            'text-xs font-medium px-2 py-0.5 rounded-full border',
            color || 'bg-muted text-muted-foreground'
          )}
        >
          {name}
        </span>
        {slug && (
          <code className="text-[11px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {slug}
          </code>
        )}
        {group && (
          <span className="text-xs text-muted-foreground">{GROUP_LABEL[group] ?? group}</span>
        )}
      </div>

      {message && <div className="px-3 pb-3 -mt-1 text-xs text-muted-foreground">{message}</div>}
    </div>
  );
});
