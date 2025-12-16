'use client';

import React, { useState } from 'react';
import { ChevronDown, CalendarDays } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { patch } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { formatDueDate, getTaskStatusIcon } from './task-utils';
import { useDriveStore } from '@/hooks/useDrive';
import { AssigneeSelect } from '@/components/layout/middle-content/page-views/task-list/AssigneeSelect';
import { DueDatePicker } from '@/components/layout/middle-content/page-views/task-list/DueDatePicker';
import { PrioritySelect } from '@/components/layout/middle-content/page-views/task-list/PrioritySelect';
import type { Task } from './useAggregatedTasks';

interface ExpandableTaskItemProps {
  task: Task;
  driveId: string;
  taskListPageId: string;
  displayStatus: Task['status'];
  onStatusToggle: (
    e: React.MouseEvent,
    taskId: string,
    status: Task['status']
  ) => void;
  onTaskUpdate?: (taskId: string, updates: Partial<Task>) => void;
  disabled?: boolean;
}

export function ExpandableTaskItem({
  task,
  driveId,
  taskListPageId,
  displayStatus,
  onStatusToggle,
  onTaskUpdate,
  disabled = false,
}: ExpandableTaskItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [updatingFields, setUpdatingFields] = useState<Set<string>>(new Set());
  const [localTask, setLocalTask] = useState(task);

  // Fallback to global currentDriveId if driveId prop is empty
  const globalDriveId = useDriveStore((state) => state.currentDriveId);
  const effectiveDriveId = driveId || globalDriveId || '';

  // Sync local task with prop when task changes
  React.useEffect(() => {
    setLocalTask(task);
  }, [task]);

  const isCompleted = displayStatus === 'completed';
  const dueDateInfo = localTask.dueDate ? formatDueDate(localTask.dueDate) : null;
  const hasMetadata =
    dueDateInfo || localTask.assignee || localTask.priority === 'high';

  const handleFieldUpdate = async (
    field: string,
    value: unknown,
    localField?: keyof Task,
    localValue?: unknown
  ) => {
    if (disabled || !taskListPageId) return;

    const previousTask = { ...localTask };
    const fieldKey = localField || field;

    if (localField) {
      setLocalTask((prev) => ({ ...prev, [localField]: localValue }));
    } else {
      setLocalTask((prev) => ({ ...prev, [field]: value }));
    }
    setUpdatingFields((prev) => new Set(prev).add(fieldKey));

    try {
      await patch(`/api/pages/${taskListPageId}/tasks/${task.id}`, {
        [field]: value,
      });
      onTaskUpdate?.(task.id, (localField ? { [localField]: localValue } : { [field]: value }) as Partial<Task>);
    } catch {
      setLocalTask(previousTask);
      toast.error(`Failed to update task`);
    } finally {
      setUpdatingFields((prev) => {
        const next = new Set(prev);
        next.delete(fieldKey);
        return next;
      });
    }
  };

  const handlePriorityChange = (priority: 'low' | 'medium' | 'high') => {
    handleFieldUpdate('priority', priority);
  };

  const handleAssigneeChange = (
    assigneeId: string | null,
    member?: { id: string; name: string | null; image: string | null } | null
  ) => {
    handleFieldUpdate('assigneeId', assigneeId, 'assignee', assigneeId === null ? null : member);
  };

  const handleDueDateChange = (date: Date | null) => {
    handleFieldUpdate('dueDate', date?.toISOString() || null);
  };

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          className={cn(
            'py-2.5 px-3 hover:bg-muted/40 transition-colors cursor-pointer',
            isCompleted && 'opacity-60'
          )}
        >
          <div className="flex items-start gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStatusToggle(e, task.id, displayStatus);
              }}
              className="flex-shrink-0 mt-0.5 hover:opacity-70 transition-opacity cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              title={
                taskListPageId
                  ? 'Click to change status'
                  : 'Status toggle unavailable'
              }
            >
              {getTaskStatusIcon(displayStatus, 'w-4 h-4')}
            </button>

            <div className="flex-1 min-w-0">
              {task.pageId && effectiveDriveId ? (
                <Link
                  href={`/dashboard/${effectiveDriveId}/${task.pageId}`}
                  className={cn(
                    'text-sm font-medium leading-tight line-clamp-2 hover:underline',
                    isCompleted && 'line-through text-muted-foreground'
                  )}
                  title={task.title}
                  onClick={(e) => e.stopPropagation()}
                >
                  {task.title}
                </Link>
              ) : (
                <span
                  className={cn(
                    'text-sm font-medium leading-tight line-clamp-2',
                    isCompleted && 'line-through text-muted-foreground'
                  )}
                  title={task.title}
                >
                  {task.title}
                </span>
              )}
            </div>

            {!disabled && (
              <div className="flex-shrink-0 p-1">
                <ChevronDown
                  className={cn(
                    'w-3 h-3 text-muted-foreground transition-transform',
                    isExpanded && 'rotate-180'
                  )}
                />
              </div>
            )}
          </div>

          {!isExpanded && hasMetadata && (
            <div className="flex items-center gap-3 mt-1.5 ml-6 text-xs">
              {dueDateInfo && (
                <span
                  className={cn('flex items-center gap-1', dueDateInfo.className)}
                >
                  <CalendarDays className="w-3 h-3" />
                  {dueDateInfo.text}
                </span>
              )}
              {localTask.assignee && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Avatar className="w-4 h-4">
                    <AvatarImage src={localTask.assignee.image || undefined} />
                    <AvatarFallback className="text-[8px]">
                      {localTask.assignee.name?.[0]?.toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate max-w-[80px]">
                    {localTask.assignee.name}
                  </span>
                </span>
              )}
              {localTask.priority === 'high' && (
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
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="py-2 px-3">
          <div className="ml-6 flex items-center gap-2 flex-wrap">
            <PrioritySelect
              currentPriority={localTask.priority}
              onSelect={handlePriorityChange}
              disabled={disabled || updatingFields.has('priority')}
              compact
            />
            {effectiveDriveId && (
              <AssigneeSelect
                driveId={effectiveDriveId}
                currentAssignee={localTask.assignee}
                onSelect={handleAssigneeChange}
                disabled={disabled || updatingFields.has('assignee')}
              />
            )}
            <DueDatePicker
              currentDate={localTask.dueDate || null}
              onSelect={handleDueDateChange}
              disabled={disabled || updatingFields.has('dueDate')}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
