import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import type { Task } from './types';
import type { AssigneeFilter, DueDateFilter, StatusGroupFilter } from './dashboardFiltersPersistence';

/** The due chips on Account › Tasks. "All" is the chip being off, not a chip. */
export type DueChipFilter = Exclude<DueDateFilter, 'all'>;

export const ACCOUNT_DUE_CHIPS: ReadonlyArray<{ filter: DueChipFilter; label: string }> = [
  { filter: 'overdue', label: 'Overdue' },
  { filter: 'today', label: 'Today' },
  { filter: 'this_week', label: 'This week' },
  { filter: 'upcoming', label: 'Upcoming' },
];

export const ACCOUNT_STATUS_GROUPS: ReadonlyArray<{ value: StatusGroupFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

/** Counts per due chip; a chip whose count could not be read is absent. */
export type DueChipCounts = Partial<Record<DueChipFilter, number>>;

export interface DriveTaskGroup {
  driveId: string;
  name: string;
  initial: string;
  tasks: Task[];
}

interface DriveRef {
  id: string;
  name: string;
}

/**
 * Groups the loaded tasks by drive. Groups follow the drive list's order, so
 * they read the same as the drive switcher; a task whose drive is not in the
 * list still gets a group, after the known ones.
 */
export function groupTasksByDrive(tasks: readonly Task[], drives: readonly DriveRef[]): DriveTaskGroup[] {
  const order = new Map(drives.map((drive, index) => [drive.id, index]));
  const names = new Map(drives.map((drive) => [drive.id, drive.name]));
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    const driveId = task.driveId ?? '';
    const bucket = groups.get(driveId);
    if (bucket) {
      bucket.push(task);
    } else {
      groups.set(driveId, [task]);
    }
  }

  const unknownRank = drives.length;
  return [...groups.entries()]
    .map(([driveId, groupTasks]) => {
      const name = names.get(driveId) ?? 'Unknown drive';
      return { driveId, name, initial: name.charAt(0).toUpperCase(), tasks: groupTasks };
    })
    .sort((a, b) => (order.get(a.driveId) ?? unknownRank) - (order.get(b.driveId) ?? unknownRank));
}

export interface DueCountScope {
  statusGroup: StatusGroupFilter;
  assigneeFilter: AssigneeFilter;
  driveId?: string;
}

/**
 * Reads each due chip's count from `pagination.total` of a one-row request, the
 * same way the rows are read, so a chip count always matches its list. A
 * failed request leaves that chip without a count rather than a guess.
 */
export async function fetchDueChipCounts(scope: DueCountScope): Promise<DueChipCounts> {
  const entries = await Promise.all(
    ACCOUNT_DUE_CHIPS.map(async ({ filter }) => {
      const params = new URLSearchParams({ context: 'user', limit: '1', offset: '0', dueDateFilter: filter });
      if (scope.statusGroup !== 'all') params.set('statusGroup', scope.statusGroup);
      if (scope.assigneeFilter === 'all') params.set('showAllAssignees', 'true');
      if (scope.driveId) params.set('driveId', scope.driveId);

      try {
        const response = await fetchWithAuth(`/api/tasks?${params.toString()}`);
        if (!response.ok) return [filter, undefined] as const;
        const data: { pagination?: { total?: unknown } } = await response.json();
        const total = data.pagination?.total;
        return [filter, typeof total === 'number' ? total : undefined] as const;
      } catch {
        return [filter, undefined] as const;
      }
    }),
  );

  const counts: DueChipCounts = {};
  for (const [filter, total] of entries) {
    if (total !== undefined) counts[filter] = total;
  }
  return counts;
}
