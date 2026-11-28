'use client';

import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';

export interface ReadinessItemView {
  id: string;
  label: string;
  status: 'ok' | 'blocking' | 'manual' | 'info';
  detail: string;
}

export interface ReadinessView {
  ready: boolean;
  mode: 'off' | 'shadow' | 'enforce' | null;
  days: number;
  items: ReadinessItemView[];
}

const STATUS: Record<ReadinessItemView['status'], { label: string; variant: 'default' | 'destructive' | 'outline' | 'secondary' }> = {
  ok: { label: 'Ready', variant: 'default' },
  blocking: { label: 'Blocks enforce', variant: 'destructive' },
  manual: { label: 'Confirm manually', variant: 'outline' },
  info: { label: 'Info', variant: 'secondary' },
};

/** The headline for a report. Pure. */
export function readinessHeadline(report: Pick<ReadinessView, 'ready' | 'mode' | 'items'>): string {
  if (report.mode === 'enforce') return 'Enforce mode is on.';
  const blocking = report.items.filter((item) => item.status === 'blocking').length;
  // Not ready with nothing to fix: the on-prem report, where scanning is always off.
  if (!report.ready && blocking === 0) return 'Content scanning is not available on this deployment: it is always off on-prem.';
  if (!report.ready) return `${blocking} check${blocking === 1 ? '' : 's'} still block${blocking === 1 ? 's' : ''} enforce mode.`;
  return 'No automated check blocks enforce mode. Confirm the manual items, then set CONTENT_SCAN_MODE=enforce.';
}

/**
 * What still stands between this deployment and CONTENT_SCAN_MODE=enforce.
 * Booleans and counts only; turning enforce on stays an environment change.
 */
export function EnforceReadiness() {
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<ReadinessView>('/api/admin/content/readiness');
  return (
    <div className="space-y-3" data-testid="enforce-readiness">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Enforce readiness</h3>
        {data && <span className="text-sm text-muted-foreground">Mode: {data.mode ?? 'unknown'}. {readinessHeadline(data)}</span>}
        <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      <DataState isLoading={isLoading} error={error} onRetry={refetch} hasData={!!data} isEmpty={!!data && data.items.length === 0} emptyMessage="Nothing to check.">
        <ul className="space-y-2">
          {data?.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-2 text-sm" data-testid="readiness-item">
              <Badge variant={STATUS[item.status].variant}>{STATUS[item.status].label}</Badge>
              <span className="font-medium">{item.label}</span>
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      </DataState>
    </div>
  );
}
