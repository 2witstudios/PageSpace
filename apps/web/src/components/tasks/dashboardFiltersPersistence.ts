import type { TaskPriority } from './types';
import type { StoredDashboardFilters } from '@/stores/useLayoutStore';

export type DueDateFilter = 'all' | 'overdue' | 'today' | 'this_week' | 'upcoming';
export type AssigneeFilter = 'mine' | 'all';
export type StatusGroupFilter = 'all' | 'active' | 'completed';

export interface PersistableFilters {
  status?: string;
  priority?: TaskPriority;
  search?: string;
  dueDateFilter?: DueDateFilter;
  assigneeFilter?: AssigneeFilter;
  statusGroup?: StatusGroupFilter;
  driveId?: string;
}

export const DEFAULT_DASHBOARD_FILTERS: PersistableFilters = {
  status: undefined,
  priority: undefined,
  driveId: undefined,
  search: undefined,
  dueDateFilter: undefined,
  assigneeFilter: 'mine',
  statusGroup: 'active',
};

const URL_FILTER_KEYS = ['status', 'priority', 'driveId', 'search', 'dueDateFilter', 'assigneeFilter', 'statusGroup'] as const;

export function scopeKeyFor(context: 'user' | 'drive', driveId: string | undefined): string {
  return context === 'user' ? 'user' : `drive:${driveId ?? ''}`;
}

function urlHasAnyPersistableParam(searchParams: URLSearchParams): boolean {
  return URL_FILTER_KEYS.some((key) => searchParams.has(key));
}

const VALID_STATUS_GROUPS: ReadonlyArray<StatusGroupFilter> = ['all', 'active', 'completed'];

function isValidStatusGroup(value: string | null): value is StatusGroupFilter {
  return value !== null && (VALID_STATUS_GROUPS as readonly string[]).includes(value);
}

function readFromUrl(searchParams: URLSearchParams): PersistableFilters {
  const status = searchParams.get('status') || undefined;
  const rawStatusGroup = searchParams.get('statusGroup');

  // Validate URL value; if absent and an explicit `status` slug is set,
  // fall back to 'all' so the API doesn't conjunctively filter both
  // (e.g. ?status=completed should not be silently ANDed with 'active').
  const statusGroup: StatusGroupFilter = isValidStatusGroup(rawStatusGroup)
    ? rawStatusGroup
    : status
      ? 'all'
      : 'active';

  return {
    status,
    priority: (searchParams.get('priority') as TaskPriority) || undefined,
    driveId: searchParams.get('driveId') || undefined,
    search: searchParams.get('search') || undefined,
    dueDateFilter: (searchParams.get('dueDateFilter') as DueDateFilter) || undefined,
    assigneeFilter: (searchParams.get('assigneeFilter') as AssigneeFilter) || 'mine',
    statusGroup,
  };
}

export function fromStoredOrDefaults(
  stored: StoredDashboardFilters | undefined,
): PersistableFilters {
  if (stored) {
    return { ...DEFAULT_DASHBOARD_FILTERS, ...stored };
  }
  return { ...DEFAULT_DASHBOARD_FILTERS };
}

export function pickInitialFilters(
  searchParams: URLSearchParams,
  stored: StoredDashboardFilters | undefined,
): PersistableFilters {
  if (urlHasAnyPersistableParam(searchParams)) {
    return readFromUrl(searchParams);
  }
  return fromStoredOrDefaults(stored);
}

export function toStoredDashboardFilters(filters: PersistableFilters): StoredDashboardFilters {
  const out: StoredDashboardFilters = {};
  if (filters.status !== undefined) out.status = filters.status;
  if (filters.priority !== undefined) out.priority = filters.priority;
  if (filters.search !== undefined) out.search = filters.search;
  if (filters.dueDateFilter !== undefined) out.dueDateFilter = filters.dueDateFilter;
  if (filters.assigneeFilter !== undefined) out.assigneeFilter = filters.assigneeFilter;
  if (filters.statusGroup !== undefined) out.statusGroup = filters.statusGroup;
  return out;
}
