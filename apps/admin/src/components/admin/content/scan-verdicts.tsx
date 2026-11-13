'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataState } from '@/components/admin/kit';
import { useAdminQuery } from '@/hooks/use-admin-query';

export interface ScanVerdictCount {
  mode: 'shadow' | 'enforce' | null;
  outcome: 'clean' | 'hash_match' | 'classifier_flag' | 'error' | 'unsupported_type' | null;
  verdict: 'clean' | 'flagged' | 'error' | 'unscanned';
  count: number;
}

const OUTCOME_LABELS: Record<NonNullable<ScanVerdictCount['outcome']>, string> = {
  clean: 'Clean',
  hash_match: 'Hash match (taken down)',
  classifier_flag: 'Classifier flag (review queue)',
  error: 'Scan error or timeout (retried on republish)',
  unsupported_type: 'Not scanned (unsupported type)',
};

const MODE_ORDER = ['shadow', 'enforce', 'review'] as const;
type ModeKey = (typeof MODE_ORDER)[number];
const MODE_LABELS: Record<ModeKey, string> = { shadow: 'Shadow', enforce: 'Enforce', review: 'Cleared by staff' };

/** Rows of mode × outcome, merged from the server's counts. Pure. */
export function verdictTable(counts: ScanVerdictCount[]): Array<{ mode: ModeKey; outcome: string; count: number }> {
  const totals = new Map<string, number>();
  for (const row of counts) {
    const mode: ModeKey = row.mode ?? 'review';
    const outcome = row.outcome ? OUTCOME_LABELS[row.outcome] : row.verdict;
    const key = `${mode}\u0000${outcome}`;
    totals.set(key, (totals.get(key) ?? 0) + row.count);
  }
  return [...totals.entries()]
    .map(([key, count]) => {
      const [mode, outcome] = key.split('\u0000') as [ModeKey, string];
      return { mode, outcome, count };
    })
    .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || b.count - a.count);
}

/**
 * Publish-scan verdicts by mode and outcome, for measuring shadow mode before
 * enforcing. Counts of the latest verdict per file; never a file, hash or preview.
 */
export function ScanVerdicts() {
  const { data, isLoading, isFetching, error, refetch } = useAdminQuery<{ counts: ScanVerdictCount[] }>('/api/admin/content/scans');
  const rows = verdictTable(data?.counts ?? []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          The latest verdict for each file the publish gate has checked. Flags are in Reports; hash matches are in Cases.
        </p>
        <Button variant="outline" size="sm" onClick={refetch} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
      <DataState isLoading={isLoading} error={error} onRetry={refetch} hasData={!!data} isEmpty={!!data && rows.length === 0} emptyMessage="No files scanned yet.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mode</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Files</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.mode}-${row.outcome}`} data-testid="scan-verdict-row">
                <TableCell>{MODE_LABELS[row.mode]}</TableCell>
                <TableCell>{row.outcome}</TableCell>
                <TableCell className="text-right tabular-nums">{row.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataState>
    </div>
  );
}
