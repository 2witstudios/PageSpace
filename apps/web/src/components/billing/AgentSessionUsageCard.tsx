'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Bot } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { formatCreditCount } from '@/lib/subscription/credits';
import { useSocketStore } from '@/stores/useSocketStore';

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          Agent sessions
        </CardTitle>
        <CardDescription>Agent sandbox runtime and cost this period</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">
            Could not load your agent session usage. Please refresh and try again.
          </p>
        ) : data.byAgentSession.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent session usage yet this period. Run code in an agent to spin one up.
          </p>
        ) : (
          <div className="space-y-3">
            {data.byAgentSession.map((session) => (
              <div
                key={session.pageId ?? session.label}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate font-medium">{session.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatRuntime(session.activeSeconds)} · {formatCreditCount(session.spendCents)} cr
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
