'use client';

import useSWR from 'swr';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Gauge } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface ConcurrencyResponse {
  inFlightHolds: { count: number; limit: number };
  codeExecutionLimit: number;
}

const fetcher = async (url: string): Promise<ConcurrencyResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

/**
 * Live in-flight AI-call count — the number the `too_many_in_flight` gate
 * checks against MACHINE_MAX_INFLIGHT on your next Machine run. Covers ALL
 * in-flight AI activity (chat/voice/machine alike), not machine sessions
 * specifically — credit_holds has no per-source column to split them.
 * Polled rather than socket-driven because `credits:updated` never fires on
 * hold creation (only release/settle), so it would miss increments.
 */
export function ConcurrencyCard() {
  const { data, error, isLoading } = useSWR<ConcurrencyResponse>(
    '/api/credits/concurrency',
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5" />
          Concurrency
        </CardTitle>
        <CardDescription>AI calls in flight right now</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-4 w-40" />
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">
            Could not load your concurrency status. Please refresh and try again.
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">In-flight AI calls</span>
              <span className="tabular-nums text-muted-foreground">
                {data.inFlightHolds.count} / {data.inFlightHolds.limit}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Includes chat, voice, and Machine runs combined — this is what a Machine run
              checks against before starting. Your tier&apos;s separate code-execution ceiling is{' '}
              {data.codeExecutionLimit} concurrent runs (enforced per server instance).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
