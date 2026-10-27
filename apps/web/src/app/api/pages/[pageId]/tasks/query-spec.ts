import { parseBoundedIntParam } from '@/lib/utils/query-params';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;
const DEFAULT_OFFSET = 0;
const MIN_OFFSET = 0;

export interface TaskQuerySpec {
  status?: string;
  /** Done-group filter resolved against the list's status configs — the Active / Completed tabs. */
  statusGroup?: 'active' | 'completed';
  /**
   * Kanban paging: `limit`/`offset` count rows within each status instead of across the
   * whole list, so a column whose cards all sit late in the list still fills its page.
   */
  perStatus: boolean;
  assigneeId?: string;
  search?: string;
  sortOrder: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * Pure parser for the GET tasks query string. Bounding limit/offset here is what
 * keeps the route's DB queries bounded — see route.ts for the OOM this prevents.
 */
export function parseTaskQuerySpec(params: URLSearchParams): TaskQuerySpec {
  const status = params.get('status');
  const assigneeId = params.get('assigneeId');
  const statusGroupParam = params.get('statusGroup');
  const statusGroup = statusGroupParam === 'active' || statusGroupParam === 'completed' ? statusGroupParam : undefined;
  const search = params.get('search');
  const sortOrder = params.get('sortOrder') === 'desc' ? 'desc' : 'asc';

  const limit = parseBoundedIntParam(params.get('limit'), {
    defaultValue: DEFAULT_LIMIT,
    min: MIN_LIMIT,
    max: MAX_LIMIT,
  });
  const offset = parseBoundedIntParam(params.get('offset'), {
    defaultValue: DEFAULT_OFFSET,
    min: MIN_OFFSET,
  });

  return {
    status: status || undefined,
    statusGroup,
    perStatus: params.get('perStatus') === 'true',
    assigneeId: assigneeId || undefined,
    search: search || undefined,
    sortOrder,
    limit,
    offset,
  };
}
