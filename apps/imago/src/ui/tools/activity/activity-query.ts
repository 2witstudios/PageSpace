// The Activity tool's filters, read from and written to the URL. The pane writes them and the
// middle reads them, so a reload or a shared address keeps the view.

export const activityRanges = ['24h', '7d', '30d'] as const;

export type ActivityRange = (typeof activityRanges)[number];

export const defaultActivityRange: ActivityRange = '7d';

const rangeMs: Readonly<Record<ActivityRange, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** The toolbar's range copy (C-Drive-Activity: "Last 7 days"). */
export const activityRangeLabel: Readonly<Record<ActivityRange, string>> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export type ActivityUrlState = {
  readonly range: ActivityRange;
  readonly actorId?: string;
  readonly operation?: string;
  readonly resourceType?: string;
};

export type ActivityFilterKey = 'range' | 'actorId' | 'operation' | 'resourceType';

const isRange = (value: string | null): value is ActivityRange =>
  (activityRanges as readonly string[]).includes(value ?? '');

/** Reads the filters from a query string; anything unknown falls back to the default view. */
export const parseActivityUrl = (params: URLSearchParams): ActivityUrlState => {
  const range = params.get('range');
  return {
    range: isRange(range) ? range : defaultActivityRange,
    actorId: params.get('actorId') || undefined,
    operation: params.get('operation') || undefined,
    resourceType: params.get('resourceType') || undefined,
  };
};

/** The query string after one filter changed; an empty value clears it. */
export const withActivityFilter = (
  current: URLSearchParams,
  key: ActivityFilterKey,
  value: string | undefined,
): URLSearchParams => {
  const next = new URLSearchParams(current);
  if (value) next.set(key, value);
  else next.delete(key);
  return next;
};

/**
 * The drive activity request for a filter state. `now` is passed in so the window is
 * computed where the request is made, not captured on render.
 */
export const activityQuery = (state: ActivityUrlState, driveId: string, now: Date): URLSearchParams => {
  const query = new URLSearchParams({
    context: 'drive',
    driveId,
    startDate: new Date(now.getTime() - rangeMs[state.range]).toISOString(),
  });
  if (state.actorId) query.set('actorId', state.actorId);
  if (state.operation) query.set('operation', state.operation);
  if (state.resourceType) query.set('resourceType', state.resourceType);
  return query;
};
