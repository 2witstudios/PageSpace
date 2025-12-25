'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { History, Loader2, Filter, RefreshCw } from 'lucide-react';
import { createClientLogger } from '@/lib/logging/client-logger';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { VersionHistoryItem } from './VersionHistoryItem';
import { useToast } from '@/hooks/useToast';
import { post } from '@/lib/auth/auth-fetch';
import type { ActivityLog } from '@/components/activity/types';

const logger = createClientLogger({ namespace: 'rollback', component: 'VersionHistoryPanel' });

interface VersionHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId?: string;
  driveId?: string;
  title?: string;
}

interface VersionWithRollback extends ActivityLog {
  canRollback: boolean;
}

interface VersionHistoryResponse {
  versions: VersionWithRollback[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  retentionDays: number;
}

export function VersionHistoryPanel({
  open,
  onOpenChange,
  pageId,
  driveId,
  title = 'Version History',
}: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VersionWithRollback[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [showAiOnly, setShowAiOnly] = useState(false);
  const [operationFilter, setOperationFilter] = useState<string>('all');
  const { toast } = useToast();

  const context = pageId ? 'page' : driveId ? 'drive' : 'user_dashboard';
  const limit = 20;

  const fetchVersions = useCallback(async (reset = false) => {
    if (!pageId && !driveId) return;

    logger.debug('[History:Fetch] Starting fetch', {
      context,
      pageId,
      driveId,
      reset,
      offset: reset ? 0 : offset,
      showAiOnly,
      operationFilter,
    });

    setLoading(true);
    const currentOffset = reset ? 0 : offset;

    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: currentOffset.toString(),
      });

      if (showAiOnly) {
        params.set('includeAiOnly', 'true');
      }
      if (operationFilter !== 'all') {
        params.set('operation', operationFilter);
      }

      const endpoint = pageId
        ? `/api/pages/${pageId}/history?${params}`
        : `/api/drives/${driveId}/history?${params}`;

      const response = await fetch(endpoint);
      if (!response.ok) {
        logger.debug('[History:Fetch] Fetch failed with status', {
          status: response.status,
          statusText: response.statusText,
        });
        throw new Error('Failed to fetch version history');
      }

      const data: VersionHistoryResponse = await response.json();

      logger.debug('[History:Fetch] Fetch successful', {
        versionsCount: data.versions.length,
        total: data.pagination.total,
        hasMore: data.pagination.hasMore,
        retentionDays: data.retentionDays,
      });

      if (reset) {
        setVersions(data.versions);
        setOffset(limit);
      } else {
        setVersions((prev) => [...prev, ...data.versions]);
        setOffset((prev) => prev + limit);
      }

      setHasMore(data.pagination.hasMore);
      setRetentionDays(data.retentionDays);
    } catch (error) {
      logger.debug('[History:Fetch] Fetch error', {
        error: error instanceof Error ? error.message : String(error),
      });
      toast({
        title: 'Error',
        description: 'Failed to load version history',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [pageId, driveId, offset, showAiOnly, operationFilter, context, toast]);

  // Keep a ref to the latest fetchVersions to avoid stale closure issues
  const fetchVersionsRef = useRef(fetchVersions);
  fetchVersionsRef.current = fetchVersions;

  // Fetch on open or filter change
  useEffect(() => {
    if (open) {
      logger.debug('[History:Panel] Panel opened, triggering fetch', {
        pageId,
        driveId,
        showAiOnly,
        operationFilter,
      });
      fetchVersionsRef.current(true);
    }
  }, [open, showAiOnly, operationFilter, pageId, driveId]);

  const handleRollback = async (activityId: string) => {
    logger.debug('[Rollback:Execute] User initiated rollback from history panel', {
      activityId,
      context,
    });

    try {
      await post(`/api/activities/${activityId}/rollback`, { context });

      logger.debug('[Rollback:Execute] Rollback completed successfully', {
        activityId,
      });

      toast({
        title: 'Success',
        description: 'Successfully restored to previous version',
      });

      // Refresh the list
      fetchVersions(true);
    } catch (error) {
      logger.debug('[Rollback:Execute] Rollback failed', {
        activityId,
        error: error instanceof Error ? error.message : String(error),
      });

      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to rollback',
        variant: 'destructive',
      });
    }
  };

  const handleLoadMore = () => {
    if (!loading && hasMore) {
      logger.debug('[History:Fetch] Loading more versions', {
        currentCount: versions.length,
        offset,
      });
      fetchVersions(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {title}
          </SheetTitle>
          <SheetDescription>
            Browse and restore previous versions.
            {retentionDays && retentionDays > 0 && (
              <span className="block mt-1 text-xs">
                History available for the last {retentionDays} days.
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        {/* Filters */}
        <div className="flex items-center gap-4 py-4 border-b">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={operationFilter} onValueChange={setOperationFilter}>
              <SelectTrigger className="w-[140px] h-8">
                <SelectValue placeholder="All operations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All operations</SelectItem>
                <SelectItem value="update">Updates</SelectItem>
                <SelectItem value="delete">Deletes</SelectItem>
                <SelectItem value="move">Moves</SelectItem>
                <SelectItem value="rollback">Rollbacks</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="ai-only"
              checked={showAiOnly}
              onCheckedChange={setShowAiOnly}
            />
            <Label htmlFor="ai-only" className="text-sm">
              AI only
            </Label>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 ml-auto"
            onClick={() => fetchVersions(true)}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Version List */}
        <ScrollArea className="flex-1 -mx-6 px-6">
          {loading && versions.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <History className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">No version history found</p>
              <p className="text-sm text-muted-foreground/60 mt-1">
                Changes will appear here as they happen
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {versions.map((version) => (
                <VersionHistoryItem
                  key={version.id}
                  activity={version}
                  context={context}
                  onRollback={version.canRollback ? handleRollback : undefined}
                />
              ))}

              {hasMore && (
                <div className="py-4 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLoadMore}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      'Load more'
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
