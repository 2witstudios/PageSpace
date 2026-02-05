'use client';

import { User, Users, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
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

export interface TaskFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  activeFilterCount: number;
  onDriveChange: (driveId: string) => void;
  onFiltersChange: (filters: Partial<{
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDateFilter?: DueDateFilter;
    assigneeFilter?: AssigneeFilter;
  }>) => void;
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
  onDriveChange,
  onFiltersChange,
  onClearFilters,
}: TaskFilterSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[80vh] pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="px-5 pt-3 pb-0">
          {/* Drag handle */}
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
          <SheetDescription className="sr-only">
            Filter your task list
          </SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto px-5 pb-4 space-y-5 mt-2">
          {/* Assignee toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Show tasks</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onFiltersChange({ assigneeFilter: 'mine' })}
                className={cn(
                  'flex h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors',
                  filters.assigneeFilter !== 'all'
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border bg-background text-muted-foreground'
                )}
              >
                <User className="h-4 w-4" />
                My tasks
              </button>
              <button
                onClick={() => onFiltersChange({ assigneeFilter: 'all' })}
                className={cn(
                  'flex h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors',
                  filters.assigneeFilter === 'all'
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border bg-background text-muted-foreground'
                )}
              >
                <Users className="h-4 w-4" />
                All tasks
              </button>
            </div>
          </div>

          {/* Drive selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Drive</label>
            <Select
              value={context === 'drive' ? selectedDriveId : (filters.driveId || 'all')}
              onValueChange={(value) => onDriveChange(value === 'all' ? '' : value)}
            >
              <SelectTrigger className="h-11 w-full">
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
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <Select
              value={filters.status || 'all'}
              onValueChange={(value) => onFiltersChange({ status: value === 'all' ? undefined : value as TaskStatus })}
            >
              <SelectTrigger className="h-11 w-full">
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
          </div>

          {/* Priority */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Priority</label>
            <Select
              value={filters.priority || 'all'}
              onValueChange={(value) => onFiltersChange({ priority: value === 'all' ? undefined : value as TaskPriority })}
            >
              <SelectTrigger className="h-11 w-full">
                <SelectValue placeholder="All priorities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Due date */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Due date</label>
            <Select
              value={filters.dueDateFilter || 'all'}
              onValueChange={(value) => onFiltersChange({ dueDateFilter: value as DueDateFilter })}
            >
              <SelectTrigger className="h-11 w-full">
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
          </div>

          {/* Apply button */}
          <Button
            className="w-full h-11"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Trigger button for the filter sheet, with active filter count badge */
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
