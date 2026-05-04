import type { TaskPriority } from './types';
import type { StoredDashboardFilters } from '@/stores/useLayoutStore';

export type DueDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
export type AssigneeFilter = 'mine' | 'all';

export interface PersistableFilters {
  status?: string;
  priority?: TaskPriority;
  search?: string;
  dueDateFilter?: DueDateFilter;
  assigneeFilter?: AssigneeFilter;
  driveId?: string;
}

export const DEFAULT_DASHBOARD_FILTERS: PersistableFilters = {
  status: undefined,
  priority: undefined,
  driveId: undefined,
  search: undefined,
  dueDateFilter: undefined,
  assigneeFilter: 'mine',
};

const URL_FILTER_KEYS = ['status', 'priority', 'driveId', 'search', 'dueDateFilter', 'assigneeFilter'] as const;

export function scopeKeyFor(context: 'user' | 'drive', driveId: string | undefined): string {
  return context === 'user' ? 'user' : `drive:${driveId ?? ''}`;
}

function urlHasAnyPersistableParam(searchParams: URLSearchParams): boolean {
  return URL_FILTER_KEYS.some((key) => searchParams.has(key));
}

function readFromUrl(searchParams: URLSearchParams): PersistableFilters {
  return {
    status: searchParams.get('status') || undefined,
    priority: (searchParams.get('priority') as TaskPriority) || undefined,
    driveId: searchParams.get('driveId') || undefined,
    search: searchParams.get('search') || undefined,
    dueDateFilter: (searchParams.get('dueDateFilter') as DueDateFilter) || undefined,
    assigneeFilter: (searchParams.get('assigneeFilter') as AssigneeFilter) || 'mine',
  };
}

export function pickInitialFilters(
  searchParams: URLSearchParams,
  stored: StoredDashboardFilters | undefined,
): PersistableFilters {
  if (urlHasAnyPersistableParam(searchParams)) {
    return readFromUrl(searchParams);
  }
  if (stored) {
    return { ...DEFAULT_DASHBOARD_FILTERS, ...stored };
  }
  return { ...DEFAULT_DASHBOARD_FILTERS };
}

export function toStoredDashboardFilters(filters: PersistableFilters): StoredDashboardFilters {
  const out: StoredDashboardFilters = {};
  if (filters.status !== undefined) out.status = filters.status;
  if (filters.priority !== undefined) out.priority = filters.priority;
  if (filters.search !== undefined) out.search = filters.search;
  if (filters.dueDateFilter !== undefined) out.dueDateFilter = filters.dueDateFilter;
  if (filters.assigneeFilter !== undefined) out.assigneeFilter = filters.assigneeFilter;
  return out;
}
