'use client';

import { useState, useMemo } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  GripVertical,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  TaskItem,
  TaskStatus,
  TaskHandlers,
  STATUS_CONFIG,
  STATUS_ORDER,
  PRIORITY_CONFIG,
} from './task-list-types';

interface TaskKanbanViewProps {
  tasks: TaskItem[];
  driveId: string;
  pageId: string;
  canEdit: boolean;
  handlers: TaskHandlers;
  editingTaskId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
  onCreateTask: (title: string, status?: TaskStatus) => void;
}

// Sortable card wrapper
interface SortableTaskCardProps {
  task: TaskItem;
  canEdit: boolean;
  driveId: string;
  handlers: TaskHandlers;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
}

function SortableTaskCard({
  task,
  canEdit,
  driveId,
  handlers,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
}: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { task } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TaskCard
        task={task}
        canEdit={canEdit}
        driveId={driveId}
        handlers={handlers}
        isEditing={isEditing}
        editingTitle={editingTitle}
        onEditingTitleChange={onEditingTitleChange}
        onCancelEdit={onCancelEdit}
        isDragging={isDragging}
        dragHandleProps={{ attributes, listeners }}
      />
    </div>
  );
}

// Task card component (used both in sortable context and drag overlay)
interface TaskCardProps {
  task: TaskItem;
  canEdit: boolean;
  driveId: string;
  handlers: TaskHandlers;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
  isDragging?: boolean;
  dragHandleProps?: {
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown> | undefined;
  };
}

function TaskCard({
  task,
  canEdit,
  driveId,
  handlers,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
  isDragging,
  dragHandleProps,
}: TaskCardProps) {
  const isCompleted = task.status === 'completed';

  return (
    <Card
      className={cn(
        'group transition-all',
        isCompleted && 'opacity-60',
        isDragging && 'opacity-50 ring-2 ring-primary'
      )}
    >
      <CardContent className="p-3">
        {/* Header: Drag handle + Checkbox + Title + Actions */}
        <div className="flex items-start gap-2">
          {canEdit && dragHandleProps && (
            <button
              {...dragHandleProps.attributes}
              {...(dragHandleProps.listeners as React.HTMLAttributes<HTMLButtonElement>)}
              className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          <Checkbox
            checked={isCompleted}
            onCheckedChange={() => handlers.onToggleComplete(task)}
            disabled={!canEdit}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <Input
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={() => {
                  if (editingTitle.trim()) {
                    handlers.onSaveTitle(task.id, editingTitle.trim());
                  }
                  onCancelEdit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') onCancelEdit();
                }}
                autoFocus
                className="h-7 text-sm"
              />
            ) : (
              <button
                type="button"
                className={cn(
                  'text-sm font-medium cursor-pointer hover:text-primary bg-transparent border-0 p-0 text-left w-full truncate',
                  isCompleted && 'line-through text-muted-foreground'
                )}
                onClick={() => handlers.onNavigate(task)}
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
                <DropdownMenuItem onClick={() => handlers.onNavigate(task)}>
                  <FileText className="h-4 w-4 mr-2" />
                  Open
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handlers.onStartEdit(task)} disabled={!canEdit}>
                <Pencil className="h-4 w-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handlers.onDelete(task.id)}
                className="text-destructive"
                disabled={!canEdit}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Metadata row */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2 ml-6">
          {/* Priority badge */}
          <Badge className={cn('text-xs px-1.5 py-0', PRIORITY_CONFIG[task.priority].color)}>
            {PRIORITY_CONFIG[task.priority].label}
          </Badge>

          {/* Assignee */}
          {(task.assignee || task.assigneeAgent) && (
            <span className="text-xs text-muted-foreground">
              {task.assignee?.name || task.assigneeAgent?.title || 'Assigned'}
            </span>
          )}

          {/* Due date */}
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

// Column header with count
interface ColumnHeaderProps {
  status: TaskStatus;
  count: number;
  canEdit: boolean;
  onAddTask: () => void;
}

function ColumnHeader({ status, count, canEdit, onAddTask }: ColumnHeaderProps) {
  const config = STATUS_CONFIG[status];

  return (
    <div className="flex items-center justify-between mb-3 px-1">
      <div className="flex items-center gap-2">
        <Badge className={cn('text-xs', config.color)}>{config.label}</Badge>
        <span className="text-sm text-muted-foreground">{count}</span>
      </div>
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onAddTask}
        >
          <Plus className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// New task input for column
interface NewTaskInputProps {
  status: TaskStatus;
  onSubmit: (title: string, status: TaskStatus) => void;
  onCancel: () => void;
}

function NewTaskInput({ status, onSubmit, onCancel }: NewTaskInputProps) {
  const [title, setTitle] = useState('');

  return (
    <Card className="mt-2">
      <CardContent className="p-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title..."
          autoFocus
          onBlur={() => {
            if (title.trim()) {
              onSubmit(title.trim(), status);
            }
            onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) {
              onSubmit(title.trim(), status);
              onCancel();
            }
            if (e.key === 'Escape') {
              onCancel();
            }
          }}
          className="h-8 text-sm"
        />
      </CardContent>
    </Card>
  );
}

export function TaskKanbanView({
  tasks,
  driveId,
  pageId,
  canEdit,
  handlers,
  editingTaskId,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
  onCreateTask,
}: TaskKanbanViewProps) {
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [addingToColumn, setAddingToColumn] = useState<TaskStatus | null>(null);

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, TaskItem[]> = {
      pending: [],
      in_progress: [],
      completed: [],
      blocked: [],
    };

    for (const task of tasks) {
      grouped[task.status].push(task);
    }

    // Sort each column by position
    for (const status of STATUS_ORDER) {
      grouped[status].sort((a, b) => {
        const posA = a.page?.position ?? a.position;
        const posB = b.page?.position ?? b.position;
        return posA - posB;
      });
    }

    return grouped;
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as TaskItem | undefined;
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    // This is called as the item moves over different droppable areas
    // We don't need to do anything here since we handle everything in dragEnd
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over || !canEdit) return;

    const activeTask = active.data.current?.task as TaskItem | undefined;
    if (!activeTask) return;

    // Determine the target status
    // The over.id could be either a task id or a column id
    let targetStatus: TaskStatus | null = null;
    let targetTask: TaskItem | null = null;

    // Check if dropped over a task
    for (const status of STATUS_ORDER) {
      const task = tasksByStatus[status].find((t) => t.id === over.id);
      if (task) {
        targetStatus = status;
        targetTask = task;
        break;
      }
    }

    // Check if dropped over a column (empty area)
    if (!targetStatus && STATUS_ORDER.includes(over.id as TaskStatus)) {
      targetStatus = over.id as TaskStatus;
    }

    if (!targetStatus) return;

    // If the status changed, update it
    if (activeTask.status !== targetStatus) {
      handlers.onStatusChange(activeTask.id, targetStatus);
    }

    // Handle reordering within or across columns
    // (For simplicity, we just update the status here.
    // Full position reordering within kanban columns could be added later)
  };

  const handleDragCancel = () => {
    setActiveTask(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 p-4 h-full overflow-x-auto">
        {STATUS_ORDER.map((status) => (
          <div
            key={status}
            className="flex-shrink-0 w-72 flex flex-col"
          >
            <ColumnHeader
              status={status}
              count={tasksByStatus[status].length}
              canEdit={canEdit}
              onAddTask={() => setAddingToColumn(status)}
            />

            <ScrollArea className="flex-1">
              <SortableContext
                id={status}
                items={tasksByStatus[status].map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <div
                  className="space-y-2 min-h-[100px] p-1 rounded-lg bg-muted/30"
                  data-status={status}
                >
                  {tasksByStatus[status].map((task) => (
                    <SortableTaskCard
                      key={task.id}
                      task={task}
                      canEdit={canEdit}
                      driveId={driveId}
                      handlers={handlers}
                      isEditing={editingTaskId === task.id}
                      editingTitle={editingTitle}
                      onEditingTitleChange={onEditingTitleChange}
                      onCancelEdit={onCancelEdit}
                    />
                  ))}

                  {tasksByStatus[status].length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No tasks
                    </div>
                  )}
                </div>
              </SortableContext>

              {addingToColumn === status && (
                <NewTaskInput
                  status={status}
                  onSubmit={(title, status) => onCreateTask(title, status)}
                  onCancel={() => setAddingToColumn(null)}
                />
              )}
            </ScrollArea>
          </div>
        ))}
      </div>

      {/* Drag overlay - shows the card being dragged */}
      <DragOverlay>
        {activeTask && (
          <TaskCard
            task={activeTask}
            canEdit={false}
            driveId={driveId}
            handlers={handlers}
            isEditing={false}
            editingTitle=""
            onEditingTitleChange={() => {}}
            onCancelEdit={() => {}}
            isDragging
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}
