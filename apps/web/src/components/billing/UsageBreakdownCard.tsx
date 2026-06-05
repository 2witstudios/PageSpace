'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { formatCreditDollars } from '@/lib/subscription/credits';
import { useSocketStore } from '@/stores/useSocketStore';

interface FeatureRow {
  source: string;
  label: string;
  spendCents: number;
  tokens: number;
  calls: number;
  sharePct: number;
}

interface ModelRow {
  model: string;
  provider: string;
  spendCents: number;
  tokens: number;
  calls: number;
  sharePct: number;
}

interface UsageBreakdownResponse {
  creditsMode: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  totalSpendCents: number;
  byFeature: FeatureRow[];
  byModel: ModelRow[];
}

const fetcher = async (url: string): Promise<UsageBreakdownResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${tokens}`;
};

/**
 * Where the user's AI credits went this billing period — spend grouped by feature
 * (chat, pulse, memory, voice, …) and by model. Reads `GET /api/credits/breakdown`
 * and live-refreshes off `credits:updated` (same signal as the balance widget).
 * Render only in credits mode (the billing page already gates this).
 */
export function UsageBreakdownCard() {
  const socket = useSocketStore((state) => state.socket);
  const connect = useSocketStore((state) => state.connect);

  const { data, error, isLoading, mutate } = useSWR<UsageBreakdownResponse>(
    '/api/credits/breakdown',
    fetcher,
    { refreshInterval: 0, revalidateOnFocus: false },
  );

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!socket) return;
    const onUpdate = () => mutate();
    socket.on('credits:updated', onUpdate);
    return () => {
      socket.off('credits:updated', onUpdate);
    };
  }, [socket, mutate]);

  const renewalDate = data?.periodEnd ? new Date(data.periodEnd) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Usage this period
        </CardTitle>
        <CardDescription>
          Where your AI credits are going{renewalDate && <> · renews {renewalDate.toLocaleDateString()}</>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">
            Could not load your usage breakdown. Please refresh and try again.
          </p>
        ) : data.totalSpendCents === 0 ? (
          <p className="text-sm text-muted-foreground">
            No AI usage yet this period. Spending starts as you use chat, agents, and other AI features.
          </p>
        ) : (
          <div className="space-y-6">
            <div className="text-2xl font-bold tabular-nums">
              {formatCreditDollars(data.totalSpendCents)}
              <span className="ml-2 text-sm font-normal text-muted-foreground">spent</span>
            </div>

            <UsageList title="By feature" rows={data.byFeature.map(featureToRow)} />
            <UsageList title="By model" rows={data.byModel.map(modelToRow)} formatTokens={formatTokens} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface DisplayRow {
  key: string;
  label: string;
  sublabel?: string;
  spendCents: number;
  tokens: number;
  calls: number;
  sharePct: number;
}

const featureToRow = (f: FeatureRow): DisplayRow => ({
  key: f.source,
  label: f.label,
  spendCents: f.spendCents,
  tokens: f.tokens,
  calls: f.calls,
  sharePct: f.sharePct,
});

const modelToRow = (m: ModelRow): DisplayRow => ({
  key: `${m.model} ${m.provider}`,
  label: m.model,
  sublabel: m.provider,
  spendCents: m.spendCents,
  tokens: m.tokens,
  calls: m.calls,
  sharePct: m.sharePct,
});

function UsageList({
  title,
  rows,
  formatTokens: fmtTokens,
}: {
  title: string;
  rows: DisplayRow[];
  formatTokens?: (t: number) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate font-medium">
                {row.label}
                {row.sublabel && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">{row.sublabel}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums">{formatCreditDollars(row.spendCents)}</span>
            </div>
            <Progress value={row.sharePct} className="h-2" />
            <div className="text-xs text-muted-foreground tabular-nums">
              {row.sharePct}% · {row.calls} {row.calls === 1 ? 'call' : 'calls'}
              {row.tokens > 0 && <> · {(fmtTokens ?? formatTokens)(row.tokens)} tokens</>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
