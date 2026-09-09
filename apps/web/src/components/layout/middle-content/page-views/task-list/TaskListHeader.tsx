'use client';

import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, BookOpen, LayoutList, Kanban } from 'lucide-react';
import { useDocumentManagerStore, DocumentManagerState } from '@/stores/useDocumentManagerStore';
import { SaveStatusIndicator } from '@/components/layout/middle-content/content-header/SaveStatusIndicator';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { buildStatusConfig, getStatusOrder } from './task-list-types';
import { useSelfTask } from './useSelfTask';
import { useTaskTree } from './task-tree-context';

interface TaskListHeaderProps {
  pageId: string;
  viewMode: 'table' | 'kanban' | 'editor';
  onViewModeChange: (mode: 'table' | 'kanban' | 'editor') => void;
  descriptionOpen?: boolean;
  onDescriptionToggle?: () => void;
  canEdit: boolean;
}

export function TaskListHeader({
  pageId,
  viewMode,
  onViewModeChange,
  descriptionOpen,
  onDescriptionToggle,
  canEdit,
}: TaskListHeaderProps) {
  const isDirty  = useDocumentManagerStore((s: DocumentManagerState) => s.documents.get(pageId)?.isDirty ?? false);
  const isSaving = useDocumentManagerStore((s: DocumentManagerState) => s.savingDocuments.has(pageId));
  const showSaveStatus = canEdit && (viewMode === 'editor' || descriptionOpen);

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b bg-background shrink-0">
      <div className="flex items-center gap-2">
        <SelfTaskControls pageId={pageId} canEdit={canEdit} />
        {onDescriptionToggle ? (
          <button
            type="button"
            onClick={onDescriptionToggle}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {descriptionOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="font-medium">Description</span>
          </button>
        ) : (
          <span className="text-sm font-medium text-muted-foreground">Description</span>
        )}
        {showSaveStatus && (
          <SaveStatusIndicator isDirty={isDirty} isSaving={isSaving} />
        )}
      </div>
      <div className="flex items-center bg-muted rounded-md p-0.5">
        <button
          type="button"
          onClick={() => onViewModeChange('editor')}
          className={cn(
            'p-1.5 rounded transition-colors',
            viewMode === 'editor'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="Editor view"
          aria-label="Editor view"
        >
          <BookOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange('table')}
          className={cn(
            'p-1.5 rounded transition-colors',
            viewMode === 'table'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="Table view"
          aria-label="Table view"
        >
          <LayoutList className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange('kanban')}
          className={cn(
            'p-1.5 rounded transition-colors',
            viewMode === 'kanban'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="Kanban view"
          aria-label="Kanban view"
        >
          <Kanban className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Complete / set the status of the task you are currently looking at.
 *
 * Every task's linked page is itself a TASK_LIST, so opening a task renders a
 * task list scoped to its children — the task becomes the container, and a
 * container renders no row for itself. Before this, the round trip "open a task
 * → finish it → go back" had no completion step at either end: the parent list
 * refuses to complete a task with open sub-tasks, and the task's own screen,
 * where those sub-tasks are, offered no control at all.
 *
 * Renders nothing when the page is not a task (a top-level list, or a task list
 * sitting under a folder).
 */
function SelfTaskControls({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  // Required, not optional. Both of TaskListView's render paths provide it, and
  // a third that forgot would otherwise degrade in silence: the header's write
  // would look foreign to the echo suppressor and cost the list a full
  // revalidation, with nothing on screen to say so.
  const { writeMachinery } = useTaskTree();
  const { task, statusConfigs, isCompleted, isAvailable, setStatus, toggleComplete } =
    useSelfTask(pageId, canEdit, writeMachinery);

  if (!isAvailable || !task) return null;

  const statusConfigMap = buildStatusConfig(statusConfigs);
  const statusOrder = getStatusOrder(statusConfigs);

  return (
    <div className="flex items-center gap-2 pr-2 mr-1 border-r">
      <Checkbox
        checked={isCompleted}
        onCheckedChange={() => void toggleComplete()}
        disabled={!canEdit}
        aria-label={isCompleted ? 'Reopen this task' : 'Complete this task'}
      />
      <Select
        value={task.status}
        onValueChange={(value) => void setStatus(value)}
        disabled={!canEdit}
      >
        <SelectTrigger className="h-7 w-28" aria-label="Status of this task">
          <SelectValue>
            <Badge className={cn('text-xs', statusConfigMap[task.status]?.color || 'bg-slate-100 text-slate-700')}>
              {statusConfigMap[task.status]?.label || task.status}
            </Badge>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {statusOrder.map((slug) => {
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
    </div>
  );
}
