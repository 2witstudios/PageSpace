'use client';

import { Activity, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActivityItem, type RollbackContext } from './ActivityItem';
import { groupActivitiesByDate } from './utils';
import type { ActivityLog, Pagination } from './types';

interface ActivityTimelineProps {
  activities: ActivityLog[];
  pagination: Pagination | null;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  emptyMessage?: string;
  emptyDescription?: string;
  context?: RollbackContext;
  onRollback?: (activityId: string, force?: boolean) => Promise<void>;
}

export function ActivityTimeline({
  activities,
  pagination,
  loading,
  loadingMore,
  onLoadMore,
  emptyMessage = 'No activity found',
  emptyDescription = 'Activity will appear here',
  context,
  onRollback,
}: ActivityTimelineProps) {
  const groupedActivities = groupActivitiesByDate(activities);

  if (loading && activities.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{emptyMessage}</p>
        <p className="text-sm">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(groupedActivities.entries()).map(([dateGroup, groupActivities]) => (
        <div key={dateGroup}>
          <h3 className="text-sm font-semibold text-muted-foreground mb-2 sticky top-0 bg-background py-2 z-10">
            {dateGroup}
          </h3>
          <div className="space-y-0">
            {groupActivities.map((activity) => (
              <ActivityItem
                key={activity.id}
                activity={activity}
                context={context}
                onRollback={onRollback}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Load More */}
      {pagination?.hasMore && (
        <div className="mt-6 text-center">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
