'use client';

import { TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MoreHorizontal, Pencil, Trash2, FileText, Zap, Bell,
  ChevronRight, ChevronDown, ListPlus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { MultiAssigneeSelect } from './MultiAssigneeSelect';
import { DueDatePicker } from './DueDatePicker';
import {
  type TaskItem,
  type TaskStatusConfig,
  type LocatedTaskHandlers,
  buildStatusConfig,
  getStatusOrder,
  isCompletedStatus,
  PRIORITY_CONFIG,
} from './task-list-types';
import {
  canExpandNode,
  depthIndentStyle,
  type TaskNodePath,
} from './task-tree-core';
import { useTaskTree } from './task-tree-context';
import { SubTaskProgress } from './SubTaskProgress';

/**
 * The seven cells of a task row, after the drag handle.
 *
 * One renderer for every depth is what makes nested rows line up with their
 * parents — column alignment across levels is most of why this pattern reads
 * as a tree rather than a second table bolted underneath.
 */
export interface TaskRowCellsProps {
  task: TaskItem;
  depth: number;
  /** The page of the list this task belongs to — where its writes are addressed. */
  listPageId: string;
  path: TaskNodePath;
  isExpanded: boolean;
  /** Vocabulary this row's dropdown may safely offer (see resolveNodeStatusConfigs). */
  statusConfigs: TaskStatusConfig[];
  /**
   * Writers bound to the cache that holds THIS row. Passed rather than read
   * from context because a nested row's cache is its own — a sub-task's toggle
   * has to patch the sub-list's pages, not the root list's.
   */
  handlers: LocatedTaskHandlers;
  /** Present only when the row can gain a sub-task inline (see the leaf bootstrap). */
  onAddSubTask?: () => void;
}

export function TaskRowCells({
  task, depth, listPageId, path, isExpanded, statusConfigs, handlers, onAddSubTask,
}: TaskRowCellsProps) {
  const {
    canEdit, driveId, onNavigate, openTriggerDialog,
    toggleExpanded, editingTaskId, editingTitle,
    onEditingTitleChange, onCancelEdit,
  } = useTaskTree();

  const loc = { listPageId, taskId: task.id };
  const isCompleted = isCompletedStatus(task.status, statusConfigs);
  const statusConfigMap = buildStatusConfig(statusConfigs);
  const statusOrder = getStatusOrder(statusConfigs);
  // `|| isExpanded`: deleting the last sub-task drops subTaskCount to 0, which
  // makes a row with no description un-expandable — while it is still OPEN, its
  // inline add row still rendering. Without this the chevron disappears and the
  // user cannot close what they can see.
  const expandable = canExpandNode(task, depth) || isExpanded;

  const commitEdit = () => {
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== task.title) handlers.onSaveTitle(loc, trimmed);
    onCancelEdit();
  };

  return (
    <>
      {/* Checkbox */}
      <TableCell>
        <Checkbox
          checked={isCompleted}
          onCheckedChange={() => handlers.onToggleComplete(loc, task)}
          disabled={!canEdit}
          aria-label={`${isCompleted ? 'Reopen' : 'Complete'} ${task.title}`}
        />
      </TableCell>

      {/* Title */}
      <TableCell>
        {editingTaskId === task.id ? (
          <Input
            value={editingTitle}
            onChange={(e) => onEditingTitleChange(e.target.value)}
            // Committed through this row's OWN handlers, not a view-level
            // callback: a nested title write has to patch the sub-list's cache.
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') onCancelEdit();
            }}
            autoFocus
            className="h-8"
          />
        ) : (
          // Indent lives here, not on the <tr>: padding on a table row is not
          // rendered. Inline because the value is dynamic.
          <div className="flex items-center gap-1" style={depthIndentStyle(depth)}>
            {expandable ? (
              <button
                type="button"
                aria-label={isExpanded ? `Collapse ${task.title}` : `Expand ${task.title}`}
                onClick={() => toggleExpanded(path)}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                {isExpanded
                  ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            ) : (
              <span className="inline-block w-[19px] shrink-0" />
            )}
            <button
              type="button"
              className={cn(
                'bg-transparent border-0 p-0 text-left cursor-pointer hover:text-primary hover:underline',
                isCompleted && 'line-through',
              )}
              onClick={() => onNavigate(task)}
            >
              {task.title}
            </button>
            <SubTaskProgress task={task} className="ml-1 shrink-0 text-xs text-muted-foreground tabular-nums" />
          </div>
        )}
      </TableCell>

      {/* Status - uses dynamic status configs */}
      <TableCell>
        <Select
          value={task.status}
          onValueChange={(value) => handlers.onStatusChange(loc, task, value)}
          disabled={!canEdit}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue>
              <Badge className={cn('text-xs', statusConfigMap[task.status]?.color || 'bg-slate-100 text-slate-700')}>
                {statusConfigMap[task.status]?.label || task.status}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {statusOrder.map(slug => {
              const cfg = statusConfigMap[slug];
              if (!cfg) return null;
              return (
                <SelectItem key={slug} value={slug}>
                  <Badge className={cn('text-xs', cfg.color)}>{cfg.label}</Badge>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </TableCell>

      {/* Priority */}
      <TableCell>
        <Select
          value={task.priority}
          onValueChange={(value) => handlers.onPriorityChange(loc, value)}
          disabled={!canEdit}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue>
              <Badge className={cn('text-xs', PRIORITY_CONFIG[task.priority].color)}>
                {PRIORITY_CONFIG[task.priority].label}
              </Badge>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PRIORITY_CONFIG).map(([key, { label, color }]) => (
              <SelectItem key={key} value={key}>
                <Badge className={cn('text-xs', color)}>{label}</Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>

      {/* Multiple Assignees */}
      <TableCell>
        <div className="flex items-center gap-1.5">
          <MultiAssigneeSelect
            driveId={driveId}
            assignees={task.assignees || []}
            onUpdate={(assigneeIds) => handlers.onMultiAssigneeChange?.(loc, assigneeIds)}
            disabled={!canEdit}
          />
          {canEdit && (task.activeTriggerCount ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => openTriggerDialog(task, listPageId)}
              title="Agent trigger configured — click to edit"
              aria-label="Agent trigger configured — click to edit"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-300/60 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300"
            >
              <Bell className="h-3 w-3" />
              <span className="sr-only">Agent trigger configured</span>
            </button>
          )}
        </div>
      </TableCell>

      {/* Due Date */}
      <TableCell>
        <DueDatePicker
          currentDate={task.dueDate}
          onSelect={(date) => handlers.onDueDateChange(loc, date)}
          disabled={!canEdit}
        />
      </TableCell>

      {/* Actions */}
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions for {task.title}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {task.pageId && (
              <DropdownMenuItem onClick={() => onNavigate(task)}>
                <FileText className="h-4 w-4 mr-2" />
                Open
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => handlers.onStartEdit(task)} disabled={!canEdit}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
            {onAddSubTask && (
              <DropdownMenuItem onClick={onAddSubTask} disabled={!canEdit}>
                <ListPlus className="h-4 w-4 mr-2" />
                Add sub-task
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => openTriggerDialog(task, listPageId)} disabled={!canEdit}>
              <Zap className="h-4 w-4 mr-2" />
              Agent triggers…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handlers.onDelete(loc)}
              className="text-destructive"
              disabled={!canEdit}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </>
  );
}
