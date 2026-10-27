'use client';

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import type { StatusConfigsByTaskList } from './types';
import { aggregateStatuses } from './task-helpers';
import {
  type DueDateFilter,
  type AssigneeFilter,
  type StatusGroupFilter,
  type FilterValues,
  StatusSelect,
  PrioritySelect,
  DueDateSelect,
  AssigneeToggle,
  StatusGroupToggle,
} from './FilterComponents';

export type { DueDateFilter, AssigneeFilter, StatusGroupFilter, FilterValues };

export interface FilterControlsProps {
  layout: 'mobile' | 'desktop';
  /**
   * In a drive, statuses come from that drive's lists and the slug-level
   * Status filter makes sense. Across all drives it would merge unrelated
   * lists' statuses in an arbitrary order, so only the status group is offered.
   */
  scopedToDrive: boolean;
  filters: FilterValues;
  hasActiveFilters: boolean;
  statusConfigsByTaskList?: StatusConfigsByTaskList;
  onFiltersChange: (filters: Partial<FilterValues>) => void;
  onClearFilters: () => void;
}

export function FilterControls({
  layout,
  scopedToDrive,
  filters,
  hasActiveFilters,
  statusConfigsByTaskList,
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
        <StatusGroupToggle
          value={filters.statusGroup || 'active'}
          onChange={(g) => onFiltersChange({ statusGroup: g })}
          className="w-full"
        />

        <div
          className="-mx-3 overflow-x-auto px-3 pb-1"
          role="region"
          aria-label="Filter options"
        >
          <div className="flex w-max min-w-full gap-2">
            {scopedToDrive && (
              <StatusSelect
                value={filters.status}
                statuses={aggregatedStatuses}
                onChange={(s) => onFiltersChange({ status: s })}
                triggerClassName="h-10 min-w-[145px]"
              />
            )}
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
      <StatusGroupToggle
        value={filters.statusGroup || 'active'}
        onChange={(g) => onFiltersChange({ statusGroup: g })}
      />
      {scopedToDrive && (
        <StatusSelect
          value={filters.status}
          statuses={aggregatedStatuses}
          onChange={(s) => onFiltersChange({ status: s })}
          triggerClassName="w-[140px]"
        />
      )}
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
