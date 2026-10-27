'use client';

import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface DataStateProps {
  isLoading: boolean;
  error: string | null;
  /** Renders the empty state when there is no error, loading is done, and this is true. */
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  /** Skeleton shown while loading; defaults to three stacked bars. */
  skeleton?: React.ReactNode;
  /**
   * True when stale data is still renderable (useAdminQuery keeps previous
   * data across refreshes). On error, the alert renders ABOVE the stale
   * content instead of replacing it — a failed background poll must not wipe
   * a populated dashboard.
   */
  hasData?: boolean;
  children: React.ReactNode;
}

/**
 * The one loading/error/empty idiom. Errors are always loud — a failed fetch
 * must never render as zeros or an empty chart.
 */
export function DataState({ isLoading, error, isEmpty, emptyMessage = 'No data for this range.', onRetry, skeleton, hasData, children }: DataStateProps) {
  if (error) {
    const alert = (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Failed to load</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{error}{hasData ? ' — showing last loaded data.' : ''}</span>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
    if (!hasData) return alert;
    return (
      <div className="space-y-4">
        {alert}
        {children}
      </div>
    );
  }
  if (isLoading) {
    return (
      <>
        {skeleton ?? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        )}
      </>
    );
  }
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        <Inbox className="h-6 w-6" aria-hidden />
        {emptyMessage}
      </div>
    );
  }
  return <>{children}</>;
}
