'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DataState } from '@/components/admin/kit';
import { dataForUrl, useAdminQuery } from '@/hooks/use-admin-query';
import type { ReportedCaseSummary } from '@/lib/content/report-summary';
import { ReportQueue, type ReviewTarget } from './report-queue';

export const REPORTS_PAGE_SIZE = 50;

/** Previous / next through the pending cases, so none past the first page is out of reach. */
export function ReportsPager({ offset, shown, onPage }: { offset: number; shown: number; onPage: (offset: number) => void }) {
  const hasNext = shown === REPORTS_PAGE_SIZE;
  if (offset === 0 && !hasNext) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>
        Cases {shown === 0 ? offset : offset + 1}–{offset + shown}
      </span>
      <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onPage(Math.max(offset - REPORTS_PAGE_SIZE, 0))}>
        Previous
      </Button>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPage(offset + REPORTS_PAGE_SIZE)}>
        Next
      </Button>
    </div>
  );
}

/** Reports waiting for review, a page at a time. "Review and act" opens the Take down tab on the case's target. */
export function ReportsTab({ onReview }: { onReview: (target: ReviewTarget) => void }) {
  const [offset, setOffset] = useState(0);
  const url = `/api/admin/content/reports?limit=${REPORTS_PAGE_SIZE}&offset=${offset}`;
  const query = useAdminQuery<{ cases: ReportedCaseSummary[] }>(url);
  const { isFetching, error, refetch } = query;
  // Only a page fetched for the current offset: the hook keeps the previous page while the next one loads.
  const current = dataForUrl(url, query);
  const items = current?.cases ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          A report never takes anything down by itself. Review the target, act from Take down, then close the report.
        </p>
        <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      {current && <ReportsPager offset={offset} shown={items.length} onPage={setOffset} />}
      <DataState
        isLoading={!current && !error}
        error={error}
        onRetry={refetch}
        hasData={!!current}
        isEmpty={!!current && items.length === 0}
        emptyMessage={offset === 0 ? 'No reports waiting for review.' : 'No more reports waiting for review.'}
      >
        <ReportQueue items={items} onChanged={refetch} onReview={onReview} />
      </DataState>
    </div>
  );
}

/** The reports on one linked case, if it has any (an alert about a report links here). */
export function LinkedCaseReports({ caseId, onReview }: { caseId: string; onReview: (target: ReviewTarget) => void }) {
  const url = `/api/admin/content/reports?id=${encodeURIComponent(caseId)}`;
  const query = useAdminQuery<{ cases: ReportedCaseSummary[] }>(url);
  if (query.error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">
        <span className="text-destructive">Could not load the reports on this case: {query.error}</span>
        <Button variant="outline" size="sm" onClick={query.refetch}>
          Retry
        </Button>
      </div>
    );
  }
  // Never the previous case's reports: the hook keeps them while this case loads.
  const items = (dataForUrl(url, query)?.cases ?? []).filter((item) => item.reportCount > 0);
  if (items.length === 0) return null;
  return <ReportQueue items={items} onChanged={query.refetch} onReview={onReview} />;
}
