'use client';

import { memo, useRef } from 'react';
import Link from 'next/link';
import { format, isPast, isToday } from 'date-fns';
import {
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { MultiAssigneeSelect } from '@/components/layout/middle-content/page-views/task-list/MultiAssigneeSelect';
import { DueDatePicker } from '@/components/layout/middle-content/page-views/task-list/DueDatePicker';
import {
  DEFAULT_STATUS_CONFIG,
  PRIORITY_CONFIG,
  STATUS_ORDER,
  type TaskPriority,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task } from './types';

export interface TaskMobileCardProps {
  task: Task;
  onStatusChange: (task: Task, status: string) => void;
  onPriorityChange: (task: Task, priority: string) => void;
  onToggleComplete: (task: Task) => void;
  onMultiAssigneeChange: (task: Task, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  onDueDateChange: (task: Task, date: Date | null) => void;
  onStartEdit: (task: Task) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onDelete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
}

export const TaskMobileCard = memo(function TaskMobileCard({
  task,
  onStatusChange,
  onPriorityChange,
  onToggleComplete,
  onMultiAssigneeChange,
  onDueDateChange,
  onStartEdit,
  onSaveTitle,
  onDelete,
  onNavigate,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
}: TaskMobileCardProps) {
  const isCompleted = task.statusGroup ? task.statusGroup === 'done' : task.status === 'completed';
  const cancelTriggeredRef = useRef(false);
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const hasLinkedPage = Boolean(task.pageId && task.driveId);

  // Safe status display
  const statusLabel = task.statusLabel || DEFAULT_STATUS_CONFIG[task.status]?.label || task.status;
  const statusColor = task.statusColor || DEFAULT_STATUS_CONFIG[task.status]?.color || 'bg-slate-100 text-slate-600';

  // Assignee display text
  const assigneeText = (task.assignees && task.assignees.length > 0)
    ? task.assignees.map(a => a.user?.name || a.agentPage?.title).filter(Boolean).join(', ')
    : (task.assignee?.name || task.assigneeAgent?.title || null);

  return (
    <Card className={cn(isCompleted && 'opacity-60')}>
      <CardContent className="p-3.5">
        <div className="flex items-start gap-3">
          <Checkbox
            checked={isCompleted}
            onCheckedChange={() => onToggleComplete(task)}
            className="mt-0.5"
          />

          <div className="min-w-0 flex-1">
            {isEditing ? (
              <Input
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={() => {
                  if (cancelTriggeredRef.current) {
                    cancelTriggeredRef.current = false;
                    return;
                  }
                  if (editingTitle.trim()) {
                    onSaveTitle(task, editingTitle.trim());
                  }
                  onCancelEdit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') {
                    cancelTriggeredRef.current = true;
                    onCancelEdit();
                  }
                }}
                autoFocus
                className="h-9"
              />
            ) : (
              <button
                type="button"
                className={cn(
                  'w-full bg-transparent border-0 p-0 text-left text-sm font-medium',
                  hasLinkedPage
                    ? 'cursor-pointer hover:text-primary'
                    : 'cursor-default',
                  isCompleted && 'line-through text-muted-foreground'
                )}
                onClick={hasLinkedPage ? () => onNavigate(task) : undefined}
                disabled={!hasLinkedPage}
                title={!hasLinkedPage ? 'No linked page' : undefined}
              >
                {task.title}
              </button>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {assigneeText && (
                <span>{assigneeText}</span>
              )}
              {dueDate && (
                <span
                  className={cn(
                    isPast(dueDate) && !isCompleted
                      ? 'text-red-500 font-medium'
                      : isToday(dueDate)
                        ? 'text-amber-500'
                        : 'text-muted-foreground'
                  )}
                >
                  {format(dueDate, 'MMM d')}
                </span>
              )}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {hasLinkedPage && (
                <DropdownMenuItem onClick={() => onNavigate(task)}>
                  <FileText className="h-4 w-4 mr-2" />
                  Open
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onStartEdit(task)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(task)}
                className="text-destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 pl-7">
          <Select
            value={task.status}
            onValueChange={(value) => onStatusChange(task, value)}
          >
            <SelectTrigger className="h-9 w-full justify-start">
              <SelectValue>
                <Badge className={cn('text-xs', statusColor)}>
                  {statusLabel}
                </Badge>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_ORDER.map((status) => {
                const config = DEFAULT_STATUS_CONFIG[status];
                return (
                  <SelectItem key={status} value={status}>
                    <Badge className={cn('text-xs', config?.color || '')}>
                      {config?.label || status}
                    </Badge>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Select
            value={task.priority}
            onValueChange={(value) => onPriorityChange(task, value)}
          >
            <SelectTrigger className="h-9 w-full justify-start">
              <SelectValue>
                <Badge className={cn('text-xs', PRIORITY_CONFIG[task.priority].color)}>
                  {PRIORITY_CONFIG[task.priority].label}
                </Badge>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(['high', 'medium', 'low'] as TaskPriority[]).map((priority) => (
                <SelectItem key={priority} value={priority}>
                  <Badge className={cn('text-xs', PRIORITY_CONFIG[priority].color)}>
                    {PRIORITY_CONFIG[priority].label}
                  </Badge>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {task.driveId && (
            <div className="col-span-2 rounded-md border bg-muted/20 px-1 py-1">
              <MultiAssigneeSelect
                driveId={task.driveId}
                assignees={task.assignees || []}
                onUpdate={(assigneeIds) => onMultiAssigneeChange(task, assigneeIds)}
              />
            </div>
          )}

          <div className="col-span-2 rounded-md border bg-muted/20 px-1 py-1">
            <DueDatePicker
              currentDate={task.dueDate}
              onSelect={(date) => onDueDateChange(task, date)}
            />
          </div>
        </div>

        {task.taskListPageTitle && task.driveId && task.taskListPageId && (
          <div className="mt-3 pl-7">
            <Link
              href={`/dashboard/${task.driveId}/${task.taskListPageId}`}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            >
              <span className="truncate">{task.taskListPageTitle}</span>
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
});
