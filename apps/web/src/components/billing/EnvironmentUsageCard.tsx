'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Boxes } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { formatCreditCount } from '@/lib/subscription/credits';
import { useSocketStore } from '@/stores/useSocketStore';

interface EnvironmentRow {
  envId: string | null;
  label: string;
  spendCents: number;
  calls: number;
  sharePct: number;
}

interface EnvironmentUsageResponse {
  byEnvironment: EnvironmentRow[];
}

const fetcher = async (url: string): Promise<EnvironmentUsageResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * Per-environment persistence cost this billing period — reads the same
 * `GET /api/credits/breakdown` payload as `UsageBreakdownCard` and
 * `AgentSessionUsageCard` (its `byEnvironment` field), so all three share one
 * SWR cache entry rather than issuing three requests.
 *
 * It is a SEPARATE card from "Agent sessions" for the reason the aggregator
 * splits the rows at all: an environment is a drive's shared machine, kept
 * because someone deliberately made it, and its charge is for a disk that
 * exists whether or not anyone ran anything. Folded into the agent list it
 * showed up as "Unattributed agent", which named the wrong thing entirely.
 *
 * No runtime column, unlike the agent-session card: these charges are metered
 * per GB-month against a window, not a wall clock, so every one of them carries
 * a zero duration.
 */
export function EnvironmentUsageCard() {
  const socket = useSocketStore((state) => state.socket);
  const connect = useSocketStore((state) => state.connect);

  const { data, error, isLoading, mutate } = useSWR<EnvironmentUsageResponse>(
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="h-5 w-5" />
          Environments
        </CardTitle>
        <CardDescription>Stored environment filesystems and their cost this period</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">
            Could not load your environment usage. Please refresh and try again.
          </p>
        ) : data.byEnvironment.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No environment usage yet this period. Environments you create in a drive keep their files
            between sessions, and appear here once they do.
          </p>
        ) : (
          <div className="space-y-3">
            {data.byEnvironment.map((environment) => (
              <div
                key={environment.envId ?? environment.label}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate font-medium">{environment.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatCreditCount(environment.spendCents)} cr · {environment.sharePct}%
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
