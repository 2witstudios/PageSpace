'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  ExternalLink,
  Trash2,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { MultiAssigneeSelect } from '@/components/layout/middle-content/page-views/task-list/MultiAssigneeSelect';
import { DueDatePicker } from '@/components/layout/middle-content/page-views/task-list/DueDatePicker';
import {
  PRIORITY_CONFIG,
  buildStatusConfig,
  getStatusOrder,
  type TaskPriority,
  type TaskStatusConfig,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task } from './types';
import { getStatusDisplay } from './task-helpers';

export interface TaskDetailSheetProps {
  task: Task | null;
  statusConfigs: TaskStatusConfig[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (task: Task, status: string) => void;
  onPriorityChange: (task: Task, priority: string) => void;
  onToggleComplete: (task: Task) => void;
  onMultiAssigneeChange: (task: Task, assigneeIds: { type: 'user' | 'agent'; id: string }[]) => void;
  onDueDateChange: (task: Task, date: Date | null) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onDelete: (task: Task) => void;
  onNavigate: (task: Task) => void;
}

export function TaskDetailSheet({
  task,
  statusConfigs,
  open,
  onOpenChange,
  onStatusChange,
  onPriorityChange,
  onToggleComplete,
  onMultiAssigneeChange,
  onDueDateChange,
  onSaveTitle,
  onDelete,
  onNavigate,
}: TaskDetailSheetProps) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitle, setEditingTitle] = useState('');
  const cancelTriggeredRef = useRef(false);

  // Reset editing state when task changes
  useEffect(() => {
    setIsEditingTitle(false);
    setEditingTitle('');
  }, [task?.id]);

  if (!task) return null;

  const statusDisplay = getStatusDisplay(task);
  const isCompleted = statusDisplay.group === 'done';
  const hasLinkedPage = Boolean(task.pageId && task.driveId);
  const { label: statusLabel, color: statusColor } = statusDisplay;
  const statusConfigMap = buildStatusConfig(statusConfigs);
  const taskStatusOrder = getStatusOrder(statusConfigs);

  const startEditTitle = () => {
    setEditingTitle(task.title);
    setIsEditingTitle(true);
  };

  const saveTitle = () => {
    if (editingTitle.trim() && editingTitle.trim() !== task.title) {
      onSaveTitle(task, editingTitle.trim());
    }
    setIsEditingTitle(false);
  };

  const handleDelete = () => {
    onDelete(task);
    onOpenChange(false);
  };

  const handleNavigate = () => {
    onNavigate(task);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[85vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="px-5 pt-3 pb-0">
          {/* Drag handle */}
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <SheetTitle className="sr-only">Task Details</SheetTitle>
          <SheetDescription className="sr-only">
            View and edit task details
          </SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto px-5 pb-4 space-y-5">
          {/* Title + Checkbox */}
          <div className="flex items-start gap-3">
            <Checkbox
              checked={isCompleted}
              onCheckedChange={() => onToggleComplete(task)}
              className="mt-1 h-5 w-5"
            />
            <div className="flex-1 min-w-0">
              {isEditingTitle ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTitle();
                      if (e.key === 'Escape') {
                        cancelTriggeredRef.current = true;
                        setIsEditingTitle(false);
                      }
                    }}
                    onBlur={() => {
                      if (cancelTriggeredRef.current) {
                        cancelTriggeredRef.current = false;
                        return;
                      }
                      saveTitle();
                    }}
                    autoFocus
                    className="h-9 text-base"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full text-left bg-transparent border-0 p-0"
                  onClick={startEditTitle}
                >
                  <span
                    className={cn(
                      'text-base font-medium leading-snug',
                      isCompleted && 'line-through text-muted-foreground'
                    )}
                  >
                    {task.title}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Status & Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select
                value={task.status}
                onValueChange={(value) => onStatusChange(task, value)}
              >
                <SelectTrigger className="h-10 w-full">
                  <SelectValue>
                    <Badge className={cn('text-xs', statusColor)}>
                      {statusLabel}
                    </Badge>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {taskStatusOrder.map((slug) => {
                    const config = statusConfigMap[slug];
                    return (
                      <SelectItem key={slug} value={slug}>
                        <Badge className={cn('text-xs', config?.color || '')}>
                          {config?.label || slug}
                        </Badge>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Priority</label>
              <Select
                value={task.priority}
                onValueChange={(value) => onPriorityChange(task, value)}
              >
                <SelectTrigger className="h-10 w-full">
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
            </div>
          </div>

          {/* Due Date */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Due Date</label>
            <div className="rounded-md border px-1 py-1">
              <DueDatePicker
                currentDate={task.dueDate}
                onSelect={(date) => onDueDateChange(task, date)}
              />
            </div>
          </div>

          {/* Assignees */}
          {task.driveId && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Assignees</label>
              <div className="rounded-md border px-1 py-1">
                <MultiAssigneeSelect
                  driveId={task.driveId}
                  assignees={task.assignees || []}
                  onUpdate={(assigneeIds) => onMultiAssigneeChange(task, assigneeIds)}
                />
              </div>
            </div>
          )}

          {/* Source task list */}
          {task.taskListPageTitle && task.driveId && task.taskListPageId && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Source</label>
              <Link
                href={`/dashboard/${task.driveId}/${task.taskListPageId}`}
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
              >
                <span className="truncate">{task.taskListPageTitle}</span>
                <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
              </Link>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            {hasLinkedPage && (
              <Button
                variant="outline"
                className="flex-1 h-11"
                onClick={handleNavigate}
              >
                <FileText className="h-4 w-4 mr-2" />
                Open Page
              </Button>
            )}
            <Button
              variant="outline"
              className="h-11 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
