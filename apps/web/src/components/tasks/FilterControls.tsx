'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
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

export interface FilterControlsProps {
  layout: 'mobile' | 'desktop';
  context: 'user' | 'drive';
  drives: Drive[];
  selectedDriveId: string | undefined;
  filters: FilterValues;
  hasActiveFilters: boolean;
  statusConfigsByTaskList?: StatusConfigsByTaskList;
  onDriveChange: (driveId: string) => void;
  onFiltersChange: (filters: Partial<FilterValues>) => void;
  onClearFilters: () => void;
}

export function FilterControls({
  layout,
  context,
  drives,
  selectedDriveId,
  filters,
  hasActiveFilters,
  statusConfigsByTaskList,
  onDriveChange,
  onFiltersChange,
  onClearFilters,
}: FilterControlsProps) {
  const isMobile = layout === 'mobile';
  const aggregatedStatuses = useMemo(
    () => aggregateStatuses(statusConfigsByTaskList),
    [statusConfigsByTaskList],
  );

  if (isMobile) {
    return (
      <>
        <div
          className="-mx-3 overflow-x-auto px-3 pb-1"
          role="region"
          aria-label="Filter options"
        >
          <div className="flex w-max min-w-full gap-2">
            <DriveSelect
              context={context}
              drives={drives}
              selectedDriveId={selectedDriveId}
              driveFilterId={filters.driveId}
              onDriveChange={onDriveChange}
              triggerClassName="h-10 min-w-[170px]"
            />
            <StatusSelect
              value={filters.status}
              statuses={aggregatedStatuses}
              onChange={(s) => onFiltersChange({ status: s })}
              triggerClassName="h-10 min-w-[145px]"
            />
            <PrioritySelect
              value={filters.priority}
              onChange={(p) => onFiltersChange({ priority: p })}
              triggerClassName="h-10 min-w-[140px]"
            />
            <DueDateSelect
              value={filters.dueDateFilter}
              onChange={(d) => onFiltersChange({ dueDateFilter: d })}
              triggerClassName="h-10 min-w-[140px]"
            />
          </div>
        </div>

        <AssigneeToggle
          variant="full"
          value={filters.assigneeFilter || 'mine'}
          onChange={(f) => onFiltersChange({ assigneeFilter: f })}
          className="grid grid-cols-2"
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-full"
            onClick={onClearFilters}
          >
            Clear filters
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <DriveSelect
        context={context}
        drives={drives}
        selectedDriveId={selectedDriveId}
        driveFilterId={filters.driveId}
        onDriveChange={onDriveChange}
        triggerClassName="w-[180px]"
      />
      <StatusSelect
        value={filters.status}
        statuses={aggregatedStatuses}
        onChange={(s) => onFiltersChange({ status: s })}
        triggerClassName="w-[140px]"
      />
      <PrioritySelect
        value={filters.priority}
        onChange={(p) => onFiltersChange({ priority: p })}
        triggerClassName="w-[130px]"
      />
      <DueDateSelect
        value={filters.dueDateFilter}
        onChange={(d) => onFiltersChange({ dueDateFilter: d })}
        triggerClassName="w-[140px]"
      />
      <AssigneeToggle
        value={filters.assigneeFilter || 'mine'}
        onChange={(f) => onFiltersChange({ assigneeFilter: f })}
      />
    </>
  );
}
