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
}

export const DEFAULT_DASHBOARD_FILTERS: PersistableFilters = {
  status: undefined,
  priority: undefined,
  search: undefined,
  dueDateFilter: undefined,
  assigneeFilter: 'mine',
  statusGroup: 'active',
};

const URL_FILTER_KEYS = ['status', 'priority', 'search', 'dueDateFilter', 'assigneeFilter', 'statusGroup'] as const;

export function scopeKeyFor(context: 'user' | 'drive', driveId: string | undefined): string {
  return context === 'user' ? 'user' : `drive:${driveId ?? ''}`;
}

/**
 * The URL wins over stored preferences only when it carries a filter this
 * focus will honour — otherwise a bookmark holding just a discarded key
 * would throw away the preferences AND show nothing for it.
 */
function urlHasHonouredParam(searchParams: URLSearchParams, scopedToDrive: boolean): boolean {
  return URL_FILTER_KEYS.some((key) => (scopedToDrive || key !== 'status') && searchParams.has(key));
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
  // The URL is read as written and forFocus decides what the focus keeps,
  // so `?status=done&statusGroup=all` under All drives loses both the slug
  // and the group it widened, the same as a persisted pair would.
  const filters = urlHasHonouredParam(searchParams, scopedToDrive)
    ? readFromUrl(searchParams)
    : fromStoredOrDefaults(stored);
  return forFocus(filters, scopedToDrive);
}

/**
 * What a focus can honour. Across all drives a slug-level `status` belongs
 * to no list in particular, and the control for it is not shown, so a
 * persisted or bookmarked one would narrow the list invisibly. Applied at
 * every entry point (mount, change) so state, URL, persistence and the
 * request never carry a filter the UI cannot show.
 */
export function forFocus(filters: PersistableFilters, scopedToDrive: boolean): PersistableFilters {
  if (scopedToDrive || filters.status === undefined) return filters;
  const { status: _status, ...withoutStatus } = filters;
  // A slug used to widen the group to 'all' so the two would not be ANDed;
  // with the slug gone that widening has no reason left either.
  return withoutStatus.statusGroup === 'all' ? { ...withoutStatus, statusGroup: 'active' } : withoutStatus;
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
