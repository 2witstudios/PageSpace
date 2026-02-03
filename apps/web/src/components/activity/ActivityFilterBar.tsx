'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DateRangeFilter } from './DateRangeFilter';
import { ActorFilter } from './ActorFilter';
import { ExportButton } from './ExportButton';
import { operationConfig } from './constants';
import type { ActivityFilters, Drive } from './types';

interface ActivityFilterBarProps {
  context: 'user' | 'drive';
  driveId?: string;
  drives?: Drive[];
  filters: ActivityFilters;
  onFiltersChange: (filters: Partial<ActivityFilters>) => void;
  onDriveChange?: (driveId: string) => void;
}

export function ActivityFilterBar({
  context,
  driveId,
  drives = [],
  filters,
  onFiltersChange,
  onDriveChange,
}: ActivityFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      {/* Drive Selector - only in user context (dashboard) */}
      {context === 'user' && drives.length > 0 && onDriveChange && (
        <Select
          value={driveId || 'all'}
          onValueChange={(value) => onDriveChange(value === 'all' ? '' : value)}
        >
          <SelectTrigger className="w-[calc(50%-4px)] sm:w-[180px]">
            <SelectValue placeholder="All drives" />
          </SelectTrigger>
          <SelectContent>
            {context === 'user' && (
              <SelectItem value="all">All drives</SelectItem>
            )}
            {drives.map((drive) => (
              <SelectItem key={drive.id} value={drive.id}>
                {drive.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Date Range Filter */}
      <DateRangeFilter
        startDate={filters.startDate}
        endDate={filters.endDate}
        onDateChange={(startDate, endDate) =>
          onFiltersChange({ startDate, endDate })
        }
      />

      {/* Actor Filter */}
      <ActorFilter
        context={context}
        driveId={driveId}
        value={filters.actorId}
        onChange={(actorId) => onFiltersChange({ actorId })}
      />

      {/* Operation Filter */}
      <Select
        value={filters.operation || 'all'}
        onValueChange={(value) =>
          onFiltersChange({ operation: value === 'all' ? undefined : value })
        }
      >
        <SelectTrigger className="w-[calc(50%-4px)] sm:w-[150px]">
          <SelectValue placeholder="Operation" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All operations</SelectItem>
          {Object.entries(operationConfig).map(([key, config]) => (
            <SelectItem key={key} value={key}>
              {config.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Resource Type Filter */}
      <Select
        value={filters.resourceType || 'all'}
        onValueChange={(value) =>
          onFiltersChange({ resourceType: value === 'all' ? undefined : value })
        }
      >
        <SelectTrigger className="w-[calc(50%-4px)] sm:w-[130px]">
          <SelectValue placeholder="Resource" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          <SelectItem value="page">Pages</SelectItem>
          <SelectItem value="drive">Drives</SelectItem>
          <SelectItem value="permission">Permissions</SelectItem>
          <SelectItem value="agent">Agents</SelectItem>
        </SelectContent>
      </Select>

      {/* Spacer - hidden on mobile */}
      <div className="hidden sm:block sm:flex-1" />

      {/* Export Button */}
      <ExportButton context={context} driveId={driveId} filters={filters} />
    </div>
  );
}
