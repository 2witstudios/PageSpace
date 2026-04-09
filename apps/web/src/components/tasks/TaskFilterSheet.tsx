'use client';

import { useMemo } from 'react';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { Drive, StatusConfigsByTaskList } from './types';
import { aggregateStatuses } from './task-helpers';
import {
  type DueDateFilter,
  type AssigneeFilter,
  type FilterValues,
  DriveSelect,
  StatusSelect,
  PrioritySelect,
  DueDateSelect,
  AssigneeToggle,
} from './FilterComponents';

export type { DueDateFilter, AssigneeFilter, FilterValues };

export interface TaskFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: 'user' | 'drive';
  drives: Drive[];
  selectedDriveId: string | undefined;
  filters: FilterValues;
  activeFilterCount: number;
  statusConfigsByTaskList?: StatusConfigsByTaskList;
  onDriveChange: (driveId: string) => void;
  onFiltersChange: (filters: Partial<FilterValues>) => void;
  onClearFilters: () => void;
}

export function TaskFilterSheet({
  open,
  onOpenChange,
  context,
  drives,
  selectedDriveId,
  filters,
  activeFilterCount,
  statusConfigsByTaskList,
  onDriveChange,
  onFiltersChange,
  onClearFilters,
}: TaskFilterSheetProps) {
  const aggregatedStatuses = useMemo(
    () => aggregateStatuses(statusConfigsByTaskList),
    [statusConfigsByTaskList],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[80vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="px-5 pt-3 pb-0">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <div className="flex items-center justify-between">
            <SheetTitle className="text-base">Filters</SheetTitle>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => {
                  onClearFilters();
                  onOpenChange(false);
                }}
              >
                Clear all
              </Button>
            )}
          </div>
          <SheetDescription className="sr-only">Filter your task list</SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto px-5 pb-4 space-y-5 mt-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Show tasks</label>
            <AssigneeToggle
              value={filters.assigneeFilter || 'mine'}
              onChange={(v) => onFiltersChange({ assigneeFilter: v })}
              variant="full"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Drive</label>
            <DriveSelect
              context={context}
              drives={drives}
              selectedDriveId={selectedDriveId}
              driveFilterId={filters.driveId}
              onDriveChange={onDriveChange}
              triggerClassName="h-11 w-full"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <StatusSelect
              value={filters.status}
              statuses={aggregatedStatuses}
              onChange={(s) => onFiltersChange({ status: s })}
              triggerClassName="h-11 w-full"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Priority</label>
            <PrioritySelect
              value={filters.priority}
              onChange={(p) => onFiltersChange({ priority: p })}
              triggerClassName="h-11 w-full"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Due date</label>
            <DueDateSelect
              value={filters.dueDateFilter}
              onChange={(d) => onFiltersChange({ dueDateFilter: d })}
              triggerClassName="h-11 w-full"
            />
          </div>

          <Button className="w-full h-11" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function TaskFilterButton({
  activeFilterCount,
  onClick,
}: {
  activeFilterCount: number;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-10 w-10 shrink-0 relative"
      onClick={onClick}
    >
      <Filter className="h-4 w-4" />
      {activeFilterCount > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
          {activeFilterCount}
        </span>
      )}
    </Button>
  );
}
