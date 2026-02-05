'use client';

import { User, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  type TaskStatus,
  type TaskPriority,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Drive } from './types';

type DueDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
type AssigneeFilter = 'mine' | 'all';

export interface FilterControlsProps {
  layout: 'mobile' | 'desktop';
  context: 'user' | 'drive';
  drives: Drive[];
  selectedDriveId: string | undefined;
  filters: {
    status?: TaskStatus;
    priority?: TaskPriority;
    driveId?: string;
    dueDateFilter?: DueDateFilter;
    assigneeFilter?: AssigneeFilter;
  };
  hasActiveFilters: boolean;
  onDriveChange: (driveId: string) => void;
  onFiltersChange: (filters: Partial<{
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDateFilter?: DueDateFilter;
    assigneeFilter?: AssigneeFilter;
  }>) => void;
  onClearFilters: () => void;
}

export function FilterControls({
  layout,
  context,
  drives,
  selectedDriveId,
  filters,
  hasActiveFilters,
  onDriveChange,
  onFiltersChange,
  onClearFilters,
}: FilterControlsProps) {
  const isMobile = layout === 'mobile';

  // Drive selector
  const DriveSelector = (
    <Select
      value={context === 'drive' ? selectedDriveId : (filters.driveId || 'all')}
      onValueChange={(value) => onDriveChange(value === 'all' ? '' : value)}
    >
      <SelectTrigger className={cn(isMobile ? 'h-10 min-w-[170px]' : 'w-[180px]')}>
        <SelectValue placeholder="All drives" />
      </SelectTrigger>
      <SelectContent>
        {context === 'user' && <SelectItem value="all">All drives</SelectItem>}
        {drives.map((drive) => (
          <SelectItem key={drive.id} value={drive.id}>
            {drive.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // Status filter
  const StatusFilter = (
    <Select
      value={filters.status || 'all'}
      onValueChange={(value) => onFiltersChange({ status: value === 'all' ? undefined : value as TaskStatus })}
    >
      <SelectTrigger className={cn(isMobile ? 'h-10 min-w-[145px]' : 'w-[140px]')}>
        <SelectValue placeholder="All statuses" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All statuses</SelectItem>
        {STATUS_ORDER.map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_CONFIG[status].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // Priority filter
  const PriorityFilter = (
    <Select
      value={filters.priority || 'all'}
      onValueChange={(value) => onFiltersChange({ priority: value === 'all' ? undefined : value as TaskPriority })}
    >
      <SelectTrigger className={cn(isMobile ? 'h-10 min-w-[140px]' : 'w-[130px]')}>
        <SelectValue placeholder="All priorities" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All priorities</SelectItem>
        <SelectItem value="high">High</SelectItem>
        <SelectItem value="medium">Medium</SelectItem>
        <SelectItem value="low">Low</SelectItem>
      </SelectContent>
    </Select>
  );

  // Due date filter
  const DueDateFilter = (
    <Select
      value={filters.dueDateFilter || 'all'}
      onValueChange={(value) => onFiltersChange({ dueDateFilter: value as DueDateFilter })}
    >
      <SelectTrigger className={cn(isMobile ? 'h-10 min-w-[140px]' : 'w-[140px]')}>
        <SelectValue placeholder="Any date" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Any date</SelectItem>
        <SelectItem value="overdue">Overdue</SelectItem>
        <SelectItem value="today">Due today</SelectItem>
        <SelectItem value="this_week">This week</SelectItem>
        <SelectItem value="upcoming">Upcoming</SelectItem>
      </SelectContent>
    </Select>
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
            {DriveSelector}
            {StatusFilter}
            {PriorityFilter}
            {DueDateFilter}
          </div>
        </div>

        {/* Assignee Filter - Mobile */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onFiltersChange({ assigneeFilter: 'mine' })}
            className={cn(
              'flex h-10 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors',
              filters.assigneeFilter !== 'all'
                ? 'border-border bg-background text-foreground shadow-sm'
                : 'border-transparent bg-muted text-muted-foreground'
            )}
            title="My tasks"
          >
            <User className="h-4 w-4" />
            <span>My tasks</span>
          </button>
          <button
            onClick={() => onFiltersChange({ assigneeFilter: 'all' })}
            className={cn(
              'flex h-10 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors',
              filters.assigneeFilter === 'all'
                ? 'border-border bg-background text-foreground shadow-sm'
                : 'border-transparent bg-muted text-muted-foreground'
            )}
            title="All tasks"
          >
            <Users className="h-4 w-4" />
            <span>All tasks</span>
          </button>
        </div>

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

  // Desktop layout
  return (
    <>
      {DriveSelector}
      {StatusFilter}
      {PriorityFilter}
      {DueDateFilter}

      {/* Assignee Filter - Desktop */}
      <div className="flex items-center bg-muted rounded-md p-0.5">
        <button
          onClick={() => onFiltersChange({ assigneeFilter: 'mine' })}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm transition-colors',
            filters.assigneeFilter !== 'all'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="My tasks"
        >
          <User className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">My tasks</span>
        </button>
        <button
          onClick={() => onFiltersChange({ assigneeFilter: 'all' })}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm transition-colors',
            filters.assigneeFilter === 'all'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          title="All tasks"
        >
          <Users className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">All tasks</span>
        </button>
      </div>
    </>
  );
}
