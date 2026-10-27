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
  useDroppable,
} from '@dnd-kit/core';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent } from '@/retained/components/ui/card';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import { Input } from '@/retained/components/ui/input';
import { Checkbox } from '@/retained/components/ui/checkbox';
import { ScrollArea } from '@/retained/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/retained/components/ui/dropdown-menu';
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  GripVertical,
  Plus,
  Zap,
} from 'lucide-react';
import { cn } from '@/retained/lib/utils';
import { compareByPagePosition } from '@/retained/services/api/task-ordering';
import {
  TaskItem,
  TaskStatusConfig,
  TaskStatusGroup,
  TaskHandlers,
  buildStatusConfig,
  getStatusOrder,
  isCompletedStatus,
  PRIORITY_CONFIG,
} from './task-list-types';
import { SubTaskProgress } from './SubTaskProgress';
import { PriorityBars } from './TaskRowCells';
import { AssigneeAvatars } from './TaskAssigneeAvatars';
import { TaskTriggerBadge } from './TaskTriggerBadge';
import { kanbanDropStatus } from './kanban-drop';

interface TaskKanbanViewProps {
  tasks: TaskItem[];
  driveId: string;
  _pageId?: string;
  canEdit: boolean;
  handlers: TaskHandlers;
  editingTaskId: string | null;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
  onCreateTask: (title: string, status?: string) => void;
  statusConfigs: TaskStatusConfig[];
}

// Sortable card wrapper
interface SortableTaskCardProps {
  task: TaskItem;
  canEdit: boolean;
  _driveId?: string;
  handlers: TaskHandlers;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
  statusConfigs: TaskStatusConfig[];
}

function SortableTaskCard({
  task,
  canEdit,
  _driveId,
  handlers,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
  statusConfigs,
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
        _driveId={_driveId}
        handlers={handlers}
        isEditing={isEditing}
        editingTitle={editingTitle}
        onEditingTitleChange={onEditingTitleChange}
        onCancelEdit={onCancelEdit}
        isDragging={isDragging}
        dragHandleProps={{ attributes, listeners }}
        statusConfigs={statusConfigs}
      />
    </div>
  );
}

// Task card component (used both in sortable context and drag overlay)
interface TaskCardProps {
  task: TaskItem;
  canEdit: boolean;
  _driveId?: string;
  handlers: TaskHandlers;
  isEditing: boolean;
  editingTitle: string;
  onEditingTitleChange: (title: string) => void;
  onCancelEdit: () => void;
  isDragging?: boolean;
  dragHandleProps?: {
    attributes: DraggableAttributes;
    listeners: SyntheticListenerMap | undefined;
  };
  statusConfigs?: TaskStatusConfig[];
}

function TaskCard({
  task,
  canEdit,
  _driveId,
  handlers,
  isEditing,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
  isDragging,
  dragHandleProps,
  statusConfigs,
}: TaskCardProps) {
  const isCompleted = isCompletedStatus(task.status, statusConfigs || []);

  return (
    <Card
      role="article"
      aria-label={task.title}
      className={cn(
        'group transition-all',
        isCompleted && 'opacity-60',
        isDragging && 'opacity-50 ring-2 ring-primary'
      )}
    >
      <CardContent className="px-3 py-2">
        {/* Header: Drag handle + Checkbox + Title + Actions */}
        <div className="flex items-start gap-2">
          {canEdit && dragHandleProps && (
            <button
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
              aria-label={`Drag ${task.title}`}
              className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          <Checkbox
            aria-label={`${isCompleted ? "Reopen" : "Complete"} ${task.title}`}
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
              {handlers.onConfigureTriggers && (
                <DropdownMenuItem
                  onClick={() => handlers.onConfigureTriggers?.(task)}
                  disabled={!canEdit}
                >
                  <Zap className="h-4 w-4 mr-2" />
                  Agent triggers…
                </DropdownMenuItem>
              )}
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

        {/* Metadata row: priority bars, sub-task progress, due (or "No date"), then the
            assignees as avatars. Trigger badge sits last, as on the list's rows. */}
        <div className="mt-2 ml-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span role="img" aria-label={`Priority ${PRIORITY_CONFIG[task.priority].label}`} className="inline-flex">
            <PriorityBars priority={task.priority} />
          </span>

          {/* Sub-task progress — parity with the table's rows. Without it a
              parent card reads as a leaf, and "In Progress" on a container tells
              you nothing about the work underneath it. */}
          <SubTaskProgress task={task} className="tabular-nums" />

          <span className="tabular-nums">
            {task.dueDate ? formatDue(task.dueDate) : 'No date'}
          </span>

          <span className="flex-1" />

          <AssigneeAvatars task={task} />

          {canEdit && handlers.onConfigureTriggers && (
            <TaskTriggerBadge
              count={task.activeTriggerCount ?? 0}
              onOpen={() => handlers.onConfigureTriggers?.(task)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The three status groups as the list names them (the list's "To do" / "In progress" / "Done" groups). */
const GROUP_LABEL: Record<TaskStatusGroup, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

const formatDue = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Column header: status name, its task count, and the status group it belongs to
interface ColumnHeaderProps {
  statusLabel: string;
  statusColor: string;
  group: TaskStatusGroup | null;
  count: number;
}

function ColumnHeader({ statusLabel, statusColor, group, count }: ColumnHeaderProps) {
  return (
    <div
      role="heading"
      aria-level={3}
      aria-label={`${statusLabel}, ${count} ${count === 1 ? "task" : "tasks"}`}
      className="flex h-10 items-center gap-2 px-2"
    >
      <Badge className={cn('text-xs', statusColor)}>{statusLabel}</Badge>
      <span className="text-sm tabular-nums text-muted-foreground">{count}</span>
      <span className="flex-1" />
      {group && (
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {GROUP_LABEL[group]}
        </span>
      )}
    </div>
  );
}

// Droppable column wrapper to allow drops on empty columns
interface KanbanColumnProps {
  status: string;
  children: React.ReactNode;
}

function KanbanColumn({ status, children }: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className="space-y-2 min-h-[100px] p-1 rounded-lg bg-muted/30"
      data-status={status}
    >
      {children}
    </div>
  );
}

// New task input for column
interface NewTaskInputProps {
  status: string;
  onSubmit: (title: string, status: string) => void;
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
  _pageId,
  canEdit,
  handlers,
  editingTaskId,
  editingTitle,
  onEditingTitleChange,
  onCancelEdit,
  onCreateTask,
  statusConfigs,
}: TaskKanbanViewProps) {
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);

  // Derive dynamic status config (memoized to avoid recomputing on every render)
  const statusConfigMap = useMemo(() => buildStatusConfig(statusConfigs), [statusConfigs]);
  const statusOrder = useMemo(() => getStatusOrder(statusConfigs), [statusConfigs]);

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, TaskItem[]> = {};
    for (const slug of statusOrder) {
      grouped[slug] = [];
    }

    for (const task of tasks) {
      if (grouped[task.status]) {
        grouped[task.status].push(task);
      } else {
        // Unknown status - put in first column
        const firstStatus = statusOrder[0];
        if (firstStatus && grouped[firstStatus]) {
          grouped[firstStatus].push(task);
        }
      }
    }

    // Sort each column by the single ordering rail, pages.position (#2143)
    for (const status of statusOrder) {
      grouped[status]?.sort((a, b) => compareByPagePosition(a, b));
    }

    return grouped;
  }, [tasks, statusOrder]);

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

  const handleDragOver = (_event: DragOverEvent) => {
    // This is called as the item moves over different droppable areas
    // We don't need to do anything here since we handle everything in dragEnd
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over || !canEdit) return;

    const activeTask = active.data.current?.task as TaskItem | undefined;
    if (!activeTask) return;

    // over.id is a card (its column's status) or a column (its status)
    const targetStatus = kanbanDropStatus(tasksByStatus, statusOrder, String(over.id));
    if (!targetStatus) return;

    // Moving a card PATCHes its status through the list's handler. Reordering
    // within a column is not written here.
    if (activeTask.status !== targetStatus) {
      handlers.onStatusChange(activeTask, targetStatus);
    }
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
      <div role="group" aria-label="Task board" className="flex gap-4 p-4 h-full overflow-x-auto @container">
        {statusOrder.map((status) => {
          const cfg = statusConfigMap[status];
          return (
          <div
            key={status}
            role="region"
            aria-label={cfg?.label || status}
            className="flex-shrink-0 w-72 @max-[500px]:w-60 flex flex-col rounded-xl bg-muted/40 p-1"
          >
            <ColumnHeader
              statusLabel={cfg?.label || status}
              statusColor={cfg?.color || 'bg-slate-100 text-slate-700'}
              group={cfg?.group ?? null}
              count={tasksByStatus[status]?.length || 0}
            />

            <ScrollArea className="flex-1">
              <SortableContext
                id={status}
                items={(tasksByStatus[status] || []).map((t) => t.id)}
                strategy={verticalListSortingStrategy}
              >
                <KanbanColumn status={status}>
                  {(tasksByStatus[status] || []).map((task) => (
                    <SortableTaskCard
                      key={task.id}
                      task={task}
                      canEdit={canEdit}
                      _driveId={driveId}
                      handlers={handlers}
                      isEditing={editingTaskId === task.id}
                      editingTitle={editingTitle}
                      onEditingTitleChange={onEditingTitleChange}
                      onCancelEdit={onCancelEdit}
                      statusConfigs={statusConfigs}
                    />
                  ))}

                  {(tasksByStatus[status]?.length || 0) === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No tasks
                    </div>
                  )}
                </KanbanColumn>
              </SortableContext>

              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-8 w-full justify-start gap-1 px-2 text-muted-foreground"
                  onClick={() => setAddingToColumn(status)}
                  aria-label={`Add task to ${cfg?.label || status}`}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add
                </Button>
              )}

              {addingToColumn === status && (
                <NewTaskInput
                  status={status}
                  onSubmit={(title, status) => onCreateTask(title, status)}
                  onCancel={() => setAddingToColumn(null)}
                />
              )}
            </ScrollArea>
          </div>
          );
        })}
      </div>

      {/* Drag overlay - shows the card being dragged */}
      <DragOverlay>
        {activeTask && (
          <TaskCard
            task={activeTask}
            canEdit={false}
            _driveId={driveId}
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
