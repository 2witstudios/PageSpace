'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { Skeleton } from '@/retained/components/ui/skeleton';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { formatWholeCredits } from '@/retained/lib/subscription/credits';
import { useSocketStore } from '@/retained/stores/useSocketStore';

interface AgentSessionRow {
  pageId: string | null;
  label: string;
  activeSeconds: number;
  spendCents: number;
  calls: number;
  sharePct: number;
}

interface AgentSessionUsageResponse {
  byAgentSession: AgentSessionRow[];
}

const fetcher = async (url: string): Promise<AgentSessionUsageResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

const formatRuntime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
};

/**
 * Per-agent-session sandbox runtime + cost this billing period — reads the same
 * `GET /api/credits/breakdown` payload as UsageBreakdownCard (its `byAgentSession` field),
 * so it shares that request's SWR cache entry rather than issuing a second one.
 * Rows are already owner-scoped by the query (see usage-breakdown-query.ts).
 */
export function AgentSessionUsageCard() {
  const socket = useSocketStore((state) => state.socket);
  const connect = useSocketStore((state) => state.connect);

  const { data, error, isLoading, mutate } = useSWR<AgentSessionUsageResponse>(
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
        Could not load your agent session usage. Please refresh and try again.
      </p>
    );
  }

  if (data.byAgentSession.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No agent session usage yet this period. Run code in an agent to spin one up.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="border-b border-border pb-2 font-medium">Agent</th>
            <th className="border-b border-border pb-2 font-medium">Runtime</th>
            <th className="border-b border-border pb-2 text-right font-medium">Calls</th>
            <th className="border-b border-border pb-2 text-right font-medium">Credits</th>
          </tr>
        </thead>
        <tbody>
          {data.byAgentSession.map((session) => (
            <tr key={session.pageId ?? session.label}>
              <td className="border-b border-border/60 py-2.5 pr-3 font-medium">{session.label}</td>
              <td className="border-b border-border/60 py-2.5 pr-3 tabular-nums">
                {formatRuntime(session.activeSeconds)}
              </td>
              <td className="border-b border-border/60 py-2.5 pr-3 text-right tabular-nums">{session.calls}</td>
              <td className="border-b border-border/60 py-2.5 text-right tabular-nums">
                {formatWholeCredits(session.spendCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
