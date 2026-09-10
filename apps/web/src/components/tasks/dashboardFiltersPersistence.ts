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

function readFromUrl(searchParams: URLSearchParams, scopedToDrive: boolean): PersistableFilters {
  // A slug status belongs to one drive's lists: outside a drive it is not
  // read at all, so it can neither narrow the list nor widen the status
  // group on its behalf.
  const status = scopedToDrive ? searchParams.get('status') || undefined : undefined;
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
  scopedToDrive = true,
): PersistableFilters {
  if (urlHasAnyPersistableParam(searchParams)) {
    return readFromUrl(searchParams, scopedToDrive);
  }
  return fromStoredOrDefaults(stored);
}

/**
 * What a focus can honour. Across all drives a slug-level `status` belongs
 * to no list in particular, and the control for it is not shown, so a
 * persisted or bookmarked one would narrow the list invisibly; and there
 * is no drive filter any more — the focus is the drive. Applied at every
 * entry point (mount, change) so state, URL, persistence and the request
 * never carry a filter the UI cannot show.
 */
export function forFocus(filters: PersistableFilters, scopedToDrive: boolean): PersistableFilters {
  const { driveId: _driveId, ...rest } = filters;
  if (scopedToDrive) return rest;
  const { status: _status, ...withoutStatus } = rest;
  return withoutStatus;
}

/**
 * Where a pre-focus bookmark `/dashboard/tasks?driveId=…&…` now lives: the
 * drive's own tasks route, with every other filter carried across.
 */
export function legacyDriveTasksHref(searchParams: URLSearchParams): string | null {
  const driveId = searchParams.get('driveId');
  if (!driveId) return null;
  const rest = new URLSearchParams(searchParams);
  rest.delete('driveId');
  const query = rest.toString();
  return query ? `/dashboard/${driveId}/tasks?${query}` : `/dashboard/${driveId}/tasks`;
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
