'use client';

import { User, Users } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { TaskStatus, TaskPriority } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import type { Drive } from './types';

export type DueDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
export type AssigneeFilter = 'mine' | 'all';

export interface FilterValues {
  status?: TaskStatus;
  priority?: TaskPriority;
  driveId?: string;
  dueDateFilter?: DueDateFilter;
  assigneeFilter?: AssigneeFilter;
}

export interface FilterSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  className?: string;
  triggerClassName?: string;
}

export function FilterSelect({
  value,
  onValueChange,
  placeholder,
  options,
  className,
  triggerClassName,
}: FilterSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={className}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface DriveSelectProps {
  context: 'user' | 'drive';
  drives: Drive[];
  selectedDriveId: string | undefined;
  driveFilterId: string | undefined;
  onDriveChange: (driveId: string) => void;
  triggerClassName?: string;
}

export function DriveSelect({
  context,
  drives,
  selectedDriveId,
  driveFilterId,
  onDriveChange,
  triggerClassName,
}: DriveSelectProps) {
  const value = context === 'drive' ? selectedDriveId : (driveFilterId || 'all');

  return (
    <Select
      value={value}
      onValueChange={(v) => onDriveChange(v === 'all' ? '' : v)}
    >
      <SelectTrigger className={triggerClassName}>
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
}

export interface StatusSelectProps {
  value: TaskStatus | undefined;
  statuses: Array<{ slug: string; label: string }>;
  onChange: (status: TaskStatus | undefined) => void;
  triggerClassName?: string;
}

export function StatusSelect({ value, statuses, onChange, triggerClassName }: StatusSelectProps) {
  return (
    <Select
      value={value || 'all'}
      onValueChange={(v) => onChange(v === 'all' ? undefined : v as TaskStatus)}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder="All statuses" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All statuses</SelectItem>
        {statuses.map((s) => (
          <SelectItem key={s.slug} value={s.slug}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface PrioritySelectProps {
  value: TaskPriority | undefined;
  onChange: (priority: TaskPriority | undefined) => void;
  triggerClassName?: string;
}

const PRIORITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All priorities' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function PrioritySelect({ value, onChange, triggerClassName }: PrioritySelectProps) {
  return (
    <Select
      value={value || 'all'}
      onValueChange={(v) => onChange(v === 'all' ? undefined : v as TaskPriority)}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder="All priorities" />
      </SelectTrigger>
      <SelectContent>
        {PRIORITY_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface DueDateSelectProps {
  value: DueDateFilter | undefined;
  onChange: (filter: DueDateFilter) => void;
  triggerClassName?: string;
}

const DUE_DATE_OPTIONS: Array<{ value: DueDateFilter; label: string }> = [
  { value: 'all', label: 'Any date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'this_week', label: 'This week' },
  { value: 'upcoming', label: 'Upcoming' },
];

export function DueDateSelect({ value, onChange, triggerClassName }: DueDateSelectProps) {
  return (
    <Select
      value={value || 'all'}
      onValueChange={(v) => onChange(v as DueDateFilter)}
    >
      <SelectTrigger className={triggerClassName}>
        <SelectValue placeholder="Any date" />
      </SelectTrigger>
      <SelectContent>
        {DUE_DATE_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface AssigneeToggleProps {
  value: AssigneeFilter;
  onChange: (filter: AssigneeFilter) => void;
  variant?: 'compact' | 'full';
  className?: string;
}

export function AssigneeToggle({ value, onChange, variant = 'compact', className }: AssigneeToggleProps) {
  const isMine = value !== 'all';

  if (variant === 'full') {
    return (
      <div className={cn('grid grid-cols-2 gap-2', className)}>
        <button
          onClick={() => onChange('mine')}
          className={cn(
            'flex h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors',
            isMine
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border bg-background text-muted-foreground'
          )}
        >
          <User className="h-4 w-4" />
          My tasks
        </button>
        <button
          onClick={() => onChange('all')}
          className={cn(
            'flex h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-colors',
            !isMine
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border bg-background text-muted-foreground'
          )}
        >
          <Users className="h-4 w-4" />
          All tasks
        </button>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center bg-muted rounded-md p-0.5', className)}>
      <button
        onClick={() => onChange('mine')}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm transition-colors',
          isMine
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="My tasks"
      >
        <User className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">My tasks</span>
      </button>
      <button
        onClick={() => onChange('all')}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm transition-colors',
          !isMine
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="All tasks"
      >
        <Users className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">All tasks</span>
      </button>
    </div>
  );
}
