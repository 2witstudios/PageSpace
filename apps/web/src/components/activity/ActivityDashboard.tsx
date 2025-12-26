'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { ActivityFilterBar } from './ActivityFilterBar';
import { ActivityTimeline } from './ActivityTimeline';
import type { ActivityLog, ActivityFilters, Drive, Pagination } from './types';
import type { RollbackContext } from './ActivityItem';
import type { ActivityActionResult } from '@/types/activity-actions';

interface ActivityDashboardProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
}

export function ActivityDashboard({ context, driveId: initialDriveId, driveName }: ActivityDashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // State
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter state from URL params
  const [selectedDriveId, setSelectedDriveId] = useState<string | undefined>(initialDriveId);
  const [filters, setFilters] = useState<ActivityFilters>(() => ({
    startDate: searchParams.get('startDate')
      ? new Date(searchParams.get('startDate') as string)
      : undefined,
    endDate: searchParams.get('endDate')
      ? new Date(searchParams.get('endDate') as string)
      : undefined,
    actorId: searchParams.get('actorId') || undefined,
    operation: searchParams.get('operation') || undefined,
    resourceType: searchParams.get('resourceType') || undefined,
    driveId: searchParams.get('driveId') || undefined,
  }));

  // Update URL when filters change
  const updateUrl = useCallback((newFilters: ActivityFilters, newDriveId?: string) => {
    const params = new URLSearchParams();

    if (newFilters.startDate) {
      params.set('startDate', newFilters.startDate.toISOString().split('T')[0]);
    }
    if (newFilters.endDate) {
      params.set('endDate', newFilters.endDate.toISOString().split('T')[0]);
    }
    if (newFilters.actorId) {
      params.set('actorId', newFilters.actorId);
    }
    if (newFilters.operation) {
      params.set('operation', newFilters.operation);
    }
    if (newFilters.resourceType) {
      params.set('resourceType', newFilters.resourceType);
    }
    // For user context, driveId is a filter (not in the URL path)
    if (newFilters.driveId && !newDriveId) {
      params.set('driveId', newFilters.driveId);
    }

    const queryString = params.toString();
    const basePath = newDriveId
      ? `/dashboard/${newDriveId}/activity`
      : '/dashboard/activity';
    const newUrl = queryString ? `${basePath}?${queryString}` : basePath;

    router.replace(newUrl, { scroll: false });
  }, [router]);

  // Fetch drives for the selector
  const fetchDrives = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/drives');
      if (!response.ok) throw new Error('Failed to fetch drives');
      const data = await response.json();
      setDrives(data);

      // If context is 'drive' and no drive selected, select first one
      if (context === 'drive' && !selectedDriveId && data.length > 0) {
        setSelectedDriveId(data[0].id);
      }
    } catch (err) {
      console.error('Error fetching drives:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedDriveId is only checked, not derived from
  }, [context]);

  // Fetch activities
  const fetchActivities = useCallback(
    async (offset = 0, append = false) => {
      if (!append) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set('context', context);
        params.set('limit', '50');
        params.set('offset', offset.toString());

        if (context === 'drive' && selectedDriveId) {
          params.set('driveId', selectedDriveId);
        } else if (context === 'user' && filters.driveId) {
          params.set('driveId', filters.driveId);
        }
        if (filters.startDate) {
          params.set('startDate', filters.startDate.toISOString());
        }
        if (filters.endDate) {
          params.set('endDate', filters.endDate.toISOString());
        }
        if (filters.actorId) {
          params.set('actorId', filters.actorId);
        }
        if (filters.operation) {
          params.set('operation', filters.operation);
        }
        if (filters.resourceType) {
          params.set('resourceType', filters.resourceType);
        }

        const response = await fetchWithAuth(`/api/activities?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch activities');
        }

        const data = await response.json();

        if (append) {
          setActivities((prev) => [...prev, ...data.activities]);
        } else {
          setActivities(data.activities);
        }
        setPagination(data.pagination);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch activities';
        setError(message);
        toast.error(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [context, selectedDriveId, filters]
  );

  // Initial load - always fetch drives (needed for drive filter in user context too)
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  // Fetch activities when filters or drive changes
  useEffect(() => {
    if (context === 'user' || (context === 'drive' && selectedDriveId)) {
      fetchActivities();
    }
  }, [context, selectedDriveId, filters, fetchActivities]);

  // Handlers
  const handleLoadMore = () => {
    if (pagination?.hasMore) {
      fetchActivities(pagination.offset + pagination.limit, true);
    }
  };

  const handleRefresh = async () => {
    await fetchActivities();
    // fetchActivities already shows error toast on failure
  };

  const handleFiltersChange = (newFilters: Partial<ActivityFilters>) => {
    const updated = { ...filters, ...newFilters };
    setFilters(updated);
    updateUrl(updated, selectedDriveId);
  };

  const handleDriveChange = (driveId: string) => {
    if (context === 'drive') {
      // For drive context, navigate to the drive's activity page
      setSelectedDriveId(driveId);
      // Clear actor filter when switching drives (actors are drive-specific)
      const updatedFilters = { ...filters, actorId: undefined };
      setFilters(updatedFilters);
      updateUrl(updatedFilters, driveId);
    } else {
      // For user context, driveId is just a filter
      const updatedFilters = { ...filters, driveId: driveId || undefined };
      setFilters(updatedFilters);
      updateUrl(updatedFilters, undefined);
    }
  };

  // Map component context to rollback API context
  const rollbackContext: RollbackContext = context === 'user' ? 'user_dashboard' : 'drive';

  const handleRollback = useCallback(async (activityId: string, force: boolean) => {
    try {
      const result = await post<ActivityActionResult>(`/api/activities/${activityId}/rollback`, {
        context: rollbackContext,
        force,
      });

      toast.success(result.message || 'Change undone');
      // Refresh the activity list
      fetchActivities();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rollback';
      toast.error(message);
      throw err;
    }
  }, [rollbackContext, fetchActivities]);

  const handleRedo = useCallback(async (activityId: string, force: boolean) => {
    try {
      const result = await post<ActivityActionResult>(`/api/activities/${activityId}/redo`, {
        context: rollbackContext,
        force,
      });

      toast.success(result.message || 'Rollback has been undone');
      fetchActivities();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to redo rollback';
      toast.error(message);
      throw err;
    }
  }, [rollbackContext, fetchActivities]);

  // Loading skeleton
  if (loading && activities.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
          <div className="space-y-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-96" />
          </div>
        </div>
      </div>
    );
  }

  const title = context === 'drive'
    ? `${driveName || drives.find(d => d.id === selectedDriveId)?.name || 'Drive'} Activity`
    : 'My Activity';

  const description = context === 'drive'
    ? 'Activity log for all members of this drive'
    : filters.driveId
      ? `Your recent activity in ${drives.find(d => d.id === filters.driveId)?.name || 'selected drive'}`
      : 'Your recent activity across all drives';

  return (
    <div className="h-full overflow-y-auto">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
        {/* Header */}
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(context === 'drive' && selectedDriveId
              ? `/dashboard/${selectedDriveId}`
              : '/dashboard'
            )}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <Button
              onClick={handleRefresh}
              variant="outline"
              size="sm"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Filter Bar */}
        <div className="mb-6">
          <ActivityFilterBar
            context={context}
            driveId={context === 'drive' ? selectedDriveId : filters.driveId}
            drives={drives}
            filters={filters}
            onFiltersChange={handleFiltersChange}
            onDriveChange={handleDriveChange}
          />
        </div>

        {/* Activity Timeline */}
        <ActivityTimeline
          activities={activities}
          pagination={pagination}
          loading={loading}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
          emptyMessage={context === 'drive' && !selectedDriveId
            ? 'Select a drive to view activity'
            : 'No activity found'
          }
          emptyDescription={context === 'drive' && !selectedDriveId
            ? 'Choose a drive from the dropdown above'
            : 'Activity will appear here as you and your team make changes'
          }
          context={rollbackContext}
          onRollback={handleRollback}
          onRedo={handleRedo}
        />
      </div>
    </div>
  );
}
