'use client';

import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, BookOpen, LayoutList, Kanban } from 'lucide-react';
import { useDocumentManagerStore, DocumentManagerState } from '@/stores/useDocumentManagerStore';
import { SaveStatusIndicator } from '@/components/layout/middle-content/content-header/SaveStatusIndicator';

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
