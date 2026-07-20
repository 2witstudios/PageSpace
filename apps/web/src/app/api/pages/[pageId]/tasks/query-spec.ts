import { parseBoundedIntParam } from '@/lib/utils/query-params';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;
const DEFAULT_OFFSET = 0;
const MIN_OFFSET = 0;

export interface TaskQuerySpec {
  status?: string;
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
    assigneeId: assigneeId || undefined,
    search: search || undefined,
    sortOrder,
    limit,
    offset,
  };
}
