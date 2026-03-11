'use client';

import { CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface TaskLoadingSkeletonProps {
  isMobile?: boolean;
}

export function TaskLoadingSkeleton({ isMobile = false }: TaskLoadingSkeletonProps) {
  if (isMobile) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-96" />
    </div>
  );
}

export interface TaskEmptyStateProps {
  context: 'user' | 'drive';
  hasDriveSelected: boolean;
  hasActiveFilters: boolean;
  onClearFilters?: () => void;
  isMobile?: boolean;
}

export function TaskEmptyState({
  context,
  hasDriveSelected,
  hasActiveFilters,
  onClearFilters,
  isMobile = false,
}: TaskEmptyStateProps) {
  const getTitle = () => {
    if (context === 'drive' && !hasDriveSelected) {
      return isMobile ? 'Select a drive' : 'Select a drive to view tasks';
    }
    return 'No tasks found';
  };

  const getDescription = () => {
    if (context === 'drive' && !hasDriveSelected) {
      return isMobile ? 'Open filters to choose a drive' : 'Choose a drive from the dropdown above';
    }
    if (hasActiveFilters) {
      return 'Try adjusting your filters';
    }
    return 'Tasks assigned to you will appear here';
  };

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        isMobile ? 'py-16 px-6' : 'py-16'
      )}
    >
      <CheckSquare
        className={cn(
          'text-muted-foreground/50 mb-4',
          isMobile ? 'h-10 w-10' : 'h-12 w-12'
        )}
      />
      <h3
        className={cn(
          'font-medium mb-1',
          isMobile ? 'text-base' : 'text-lg'
        )}
      >
        {getTitle()}
      </h3>
      <p className="text-sm text-muted-foreground">{getDescription()}</p>
      {hasActiveFilters && onClearFilters && (
        <Button
          variant="outline"
          size="sm"
          onClick={onClearFilters}
          className={cn(isMobile ? 'mt-3' : 'mt-4')}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
