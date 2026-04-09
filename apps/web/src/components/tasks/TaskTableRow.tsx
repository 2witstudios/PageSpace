'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { ExternalLink, MoreHorizontal, Pencil, Trash2, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
import { TableRow, TableCell } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { DueDatePicker } from '@/components/layout/middle-content/page-views/task-list/DueDatePicker';
import { MultiAssigneeSelect } from '@/components/layout/middle-content/page-views/task-list/MultiAssigneeSelect';
import {
  PRIORITY_CONFIG,
  buildStatusConfig,
  getStatusOrder,
  type TaskPriority,
  type TaskStatusConfig,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Task } from './types';
import { getStatusDisplay } from './task-helpers';

export interface TaskTableRowProps {
  task: Task;
  statusConfigs: TaskStatusConfig[];
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

export function TaskTableRow({
  task,
  statusConfigs,
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
}: TaskTableRowProps) {
  const statusDisplay = getStatusDisplay(task);
  const isCompleted = statusDisplay.group === 'done';
  const cancelTriggeredRef = useRef(false);
  const statusConfigMap = buildStatusConfig(statusConfigs);
  const taskStatusOrder = getStatusOrder(statusConfigs);

  return (
    <TableRow className={cn('group', isCompleted && 'opacity-60')}>
      <TableCell>
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => onToggleComplete(task)}
        />
      </TableCell>

      <TableCell>
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
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                cancelTriggeredRef.current = true;
                onCancelEdit();
              }
            }}
            autoFocus
            className="h-8"
          />
        ) : (
          <button
            type="button"
            className={cn(
              'font-medium bg-transparent border-0 p-0 text-left',
              task.pageId && task.driveId
                ? 'cursor-pointer hover:text-primary hover:underline'
                : 'cursor-default',
              isCompleted && 'line-through text-muted-foreground'
            )}
            onClick={task.pageId && task.driveId ? () => onNavigate(task) : undefined}
            disabled={!task.pageId || !task.driveId}
            title={!task.pageId || !task.driveId ? 'No linked page' : undefined}
          >
            {task.title}
          </button>
        )}
      </TableCell>

      <TableCell>
        <Select
          value={task.status}
          onValueChange={(value) => onStatusChange(task, value)}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue>
              <Badge className={cn('text-xs', statusDisplay.color)}>
                {statusDisplay.label}
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
      </TableCell>

      <TableCell>
        <Select
          value={task.priority}
          onValueChange={(value) => onPriorityChange(task, value)}
        >
          <SelectTrigger className="h-8 w-24">
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
      </TableCell>

      <TableCell>
        {task.driveId && (
          <MultiAssigneeSelect
            driveId={task.driveId}
            assignees={task.assignees || []}
            onUpdate={(assigneeIds) => onMultiAssigneeChange(task, assigneeIds)}
          />
        )}
      </TableCell>

      <TableCell>
        <DueDatePicker
          currentDate={task.dueDate}
          onSelect={(date) => onDueDateChange(task, date)}
        />
      </TableCell>

      <TableCell>
        {task.taskListPageTitle && task.driveId && task.taskListPageId && (
          <Link
            href={`/dashboard/${task.driveId}/${task.taskListPageId}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md bg-muted hover:bg-muted/80 transition-colors max-w-[150px]"
          >
            <span className="truncate">{task.taskListPageTitle}</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
          </Link>
        )}
      </TableCell>

      <TableCell>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {task.pageId && (
                <DropdownMenuItem onClick={() => onNavigate(task)}>
                  <FileText className="h-4 w-4 mr-2" />
                  Open
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onStartEdit(task)}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDelete(task)} className="text-destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}
