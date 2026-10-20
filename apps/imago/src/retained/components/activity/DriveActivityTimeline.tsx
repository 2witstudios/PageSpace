'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from '@/retained-adapters/navigation';
import { toast } from 'sonner';
import { fetchWithAuth, post } from '@/retained/lib/auth/auth-fetch';
import type { ActivityActionResult } from '@/retained/types/activity-actions';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { activityQuery, activityRangeLabel, parseActivityUrl, type ActivityUrlState } from '@/ui/tools/activity/activity-query';
import { ActivityTimeline } from './ActivityTimeline';
import type { ActivityLog, Pagination } from './types';

const PAGE_SIZE = 50;

type ActivityPage = { activities: ActivityLog[]; pagination: Pagination };

/** One page of the drive's activity for a filter state, read against `now`. */
const fetchPage = async (driveId: string | null, state: ActivityUrlState, offset: number, now: Date): Promise<ActivityPage> => {
  const query = activityQuery(state, driveId, now);
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(offset));
  const response = await fetchWithAuth(`/api/activities?${query.toString()}`);
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to fetch activities');
  }
  return response.json();
};

/**
 * The Activity middle for a drive (C-Drive-Activity): a 44px toolbar with the range and the
 * event total, then the day-grouped timeline. The filters are the pane's; they arrive in the URL.
 * With no drive (Home, the dashboard) it is the viewer's own activity across every drive.
 */
export function DriveActivityTimeline({ driveId }: { driveId: string | null }) {
  const rollbackContext = driveId === null ? 'user_dashboard' : 'drive';
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const state = useMemo(() => parseActivityUrl(new URLSearchParams(urlKey)), [urlKey]);

  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  // A new filter (or a rollback) replaces the list; a response for an older filter is dropped.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    fetchPage(driveId, state, 0, new Date())
      .then((page) => {
        if (stale) return;
        setActivities(page.activities);
        setPagination(page.pagination);
      })
      .catch((err: unknown) => {
        if (stale) return;
        const message = err instanceof Error ? err.message : 'Failed to fetch activities';
        setError(message);
        setActivities([]);
        setPagination(null);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [driveId, state, revision]);

  const handleLoadMore = async () => {
    if (!pagination?.hasMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(driveId, state, pagination.offset + pagination.limit, new Date());
      setActivities((prev) => [...prev, ...page.activities]);
      setPagination(page.pagination);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to fetch activities');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleRollback = async (activityId: string, force: boolean): Promise<ActivityActionResult> => {
    try {
      const result = await post<ActivityActionResult>(`/api/activities/${activityId}/rollback`, {
        context: rollbackContext,
        force,
      });
      toast.success(result.message || 'Change undone');
      setRevision((n) => n + 1);
      return result;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rollback');
      throw err;
    }
  };

  // A change that a later rollback linked back to is marked "Rolled back".
  const rolledBackIds = useMemo(
    () => new Set(activities.flatMap((activity) => (activity.rollbackFromActivityId ? [activity.rollbackFromActivityId] : []))),
    [activities],
  );

  return (
    <div className="flex min-h-full flex-col">
      <ToolbarStrip label="Activity">
        <span className="text-xs text-muted-foreground">{activityRangeLabel[state.range]}</span>
        {pagination ? <span className="ml-auto text-xs text-muted-foreground">{`${pagination.total} events`}</span> : null}
      </ToolbarStrip>
      <div className="px-4 py-4 sm:px-6">
        {error ? (
          <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>
        ) : null}
        <ActivityTimeline
          activities={activities}
          pagination={pagination}
          loading={loading}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          emptyMessage="No activity found"
          emptyDescription="Activity will appear here as you and your team make changes"
          context={rollbackContext}
          onRollback={handleRollback}
          rolledBackIds={rolledBackIds}
        />
      </div>
    </div>
  );
}
