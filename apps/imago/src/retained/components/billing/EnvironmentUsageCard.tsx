'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { formatWholeCredits } from '@/retained/lib/subscription/credits';
import { useSocketStore } from '@/retained/stores/useSocketStore';

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

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load your environment usage. Please refresh and try again.
      </p>
    );
  }

  if (data.byEnvironment.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No environment usage yet this period. Environments you create in a drive keep their files
        between sessions, and appear here once they do.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Stored environments</h3>
      {data.byEnvironment.map((environment) => (
        <div
          key={environment.envId ?? environment.label}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="truncate font-medium">{environment.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatWholeCredits(environment.spendCents)} credits · {environment.sharePct}%
          </span>
        </div>
      ))}
    </div>
  );
}
