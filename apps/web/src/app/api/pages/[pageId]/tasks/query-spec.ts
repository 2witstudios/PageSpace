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

/**
 * Escapes ILIKE wildcard/escape characters (`%`, `_`, `\`) in a search term so it
 * matches as a literal substring. Postgres's default LIKE/ILIKE escape character is
 * backslash — without this, a search term containing one of these characters (e.g.
 * a task titled "50% off") would be interpreted as a pattern, not literal text,
 * silently over- or under-matching against the bounded query's ilike(pages.title, ...).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
