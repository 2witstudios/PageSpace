'use client';

import { useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Pencil, Trash2, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import type { TaskStatusGroup } from '@/lib/task-status-config';
import type { Task } from './types';
import { getStatusDisplay, getAssigneeText } from './task-helpers';
import { PRIORITY_CONFIG } from '@/components/layout/middle-content/page-views/task-list/task-list-types';

export const STATUS_GROUP_CONFIG: Record<TaskStatusGroup, { label: string; color: string }> = {
  todo: { label: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300' },
  done: { label: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
};

export interface KanbanCardProps {
  task: Task;
  isDragging?: boolean;
  onToggleComplete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onCancelEdit: () => void;
}

export function KanbanCard({
  task,
  isDragging,
  onToggleComplete,
  onNavigate,
  onStartEdit,
  onDelete,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onSaveTitle,
  onCancelEdit,
}: KanbanCardProps) {
  const statusDisplay = getStatusDisplay(task);
  const isCompleted = statusDisplay.group === 'done';
  const cancelTriggeredRef = useRef(false);

  return (
    <Card
      className={cn(
        'group transition-all cursor-grab active:cursor-grabbing',
        isCompleted && 'opacity-60',
        isDragging && 'opacity-50 ring-2 ring-primary'
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <Checkbox
            checked={isCompleted}
            onCheckedChange={() => onToggleComplete(task)}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
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
                className="h-7 text-sm"
              />
            ) : (
              <button
                type="button"
                className={cn(
                  'text-sm font-medium bg-transparent border-0 p-0 text-left w-full truncate',
                  task.pageId && task.driveId
                    ? 'cursor-pointer hover:text-primary'
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
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreHorizontal className="h-3 w-3" />
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

        <div className="flex flex-wrap items-center gap-1.5 mt-2 ml-6">
          <Badge className={cn('text-xs px-1.5 py-0', PRIORITY_CONFIG[task.priority].color)}>
            {PRIORITY_CONFIG[task.priority].label}
          </Badge>
          {(() => {
            const text = getAssigneeText(task);
            return text ? (
              <span className="text-xs text-muted-foreground truncate max-w-[80px]">{text}</span>
            ) : null;
          })()}
          {task.dueDate && (
            <span className="text-xs text-muted-foreground">
              {new Date(task.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export type SortableKanbanCardProps = KanbanCardProps;

export function SortableKanbanCard(props: SortableKanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <KanbanCard {...props} isDragging={isDragging} />
    </div>
  );
}

export interface KanbanColumnProps {
  statusGroup: TaskStatusGroup;
  tasks: Task[];
  onToggleComplete: (task: Task) => void;
  onNavigate: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  editingTaskId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onSaveTitle: (task: Task, title: string) => void;
  onCancelEdit: () => void;
}

export function KanbanColumn({
  statusGroup,
  tasks,
  onToggleComplete,
  onNavigate,
  onStartEdit,
  onDelete,
  editingTaskId,
  editingTitle,
  onEditingTitleChange,
  onSaveTitle,
  onCancelEdit,
}: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({ id: statusGroup });
  const config = STATUS_GROUP_CONFIG[statusGroup];

  return (
    <div className="flex-shrink-0 w-72 flex flex-col">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Badge className={cn('text-xs', config.color)}>{config.label}</Badge>
          <span className="text-sm text-muted-foreground">{tasks.length}</span>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <SortableContext
          id={statusGroup}
          items={tasks.map(t => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div
            ref={setNodeRef}
            className="space-y-2 min-h-[100px] p-1 rounded-lg bg-muted/30"
          >
            {tasks.map((task) => (
              <SortableKanbanCard
                key={task.id}
                task={task}
                onToggleComplete={onToggleComplete}
                onNavigate={onNavigate}
                onStartEdit={onStartEdit}
                onDelete={onDelete}
                isEditing={editingTaskId === task.id}
                editingTitle={editingTitle}
                onEditingTitleChange={onEditingTitleChange}
                onSaveTitle={onSaveTitle}
                onCancelEdit={onCancelEdit}
              />
            ))}
            {tasks.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No tasks
              </div>
            )}
          </div>
        </SortableContext>
      </ScrollArea>
    </div>
  );
}
