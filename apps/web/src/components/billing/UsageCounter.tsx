'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle } from 'lucide-react';
import useSWR from 'swr';
import { useSocketStore } from '@/stores/socketStore';
import type { UsageEventPayload } from '@/lib/socket-utils';
import { createClientLogger } from '@/lib/logging/client-logger';
import { maskIdentifier } from '@/lib/logging/mask';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';

const usageLogger = createClientLogger({ namespace: 'usage', component: 'usage-counter' });

interface UsageData {
  subscriptionTier: 'free' | 'pro' | 'business';
  standard: {
    current: number;
    limit: number;
    remaining: number;
  };
  pro: {
    current: number;
    limit: number;
    remaining: number;
  };
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function UsageCounter() {
  const router = useRouter();
  const { connect, getSocket } = useSocketStore();

  // Check if any editing or streaming is active (state-based)
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  const { data: usage, error, mutate } = useSWR<UsageData>('/api/subscriptions/usage', fetcher, {
    refreshInterval: 0, // Disabled - rely on Socket.IO for real-time updates
    revalidateOnFocus: false, // Don't revalidate on tab focus (prevents interruptions)
    isPaused: () => isAnyActive, // Pause revalidation during editing/streaming
  });

  const isPro = usage?.subscriptionTier === 'pro';
  const isBusiness = usage?.subscriptionTier === 'business';
  const isPaid = isPro || isBusiness;
  const isNearLimit = usage && usage.standard.limit > 0 && usage.standard.remaining <= 10;

  const handleBillingClick = () => {
    router.push('/settings/billing');
  };

  // Connect to Socket.IO and listen for usage events
  useEffect(() => {
    connect();
    const socket = getSocket();

    if (socket) {
      const handleUsageUpdated = (payload: UsageEventPayload) => {
        usageLogger.debug('Received usage update payload', {
          userId: maskIdentifier(payload.userId),
          subscriptionTier: payload.subscriptionTier,
          standard: payload.standard,
          pro: payload.pro,
        });

        // Update SWR cache with new usage data
        mutate({
          subscriptionTier: payload.subscriptionTier,
          standard: payload.standard,
          pro: payload.pro
        }, false); // Don't revalidate, trust the real-time data
      };

      socket.on('usage:updated', handleUsageUpdated);

      // Cleanup listener on unmount
      return () => {
        socket.off('usage:updated', handleUsageUpdated);
      };
    }
  }, [connect, getSocket, mutate]);

  // Refresh usage when AI conversations complete (fallback)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        mutate();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [mutate]);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        <span className="hidden md:inline">Usage unavailable</span>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="h-4 w-4 animate-pulse bg-muted rounded" />
        <span className="hidden md:inline">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Usage Display */}
      <div className="flex items-center gap-3 text-sm">
        {/* Standard Usage */}
        <div className="flex items-center gap-1.5">
          <span className="hidden lg:inline text-muted-foreground text-xs">Standard:</span>
          <Badge
            variant={isNearLimit ? "destructive" : "secondary"}
            className="text-xs font-medium"
          >
            {usage.standard.current}/{usage.standard.limit}
          </Badge>
          <span className="hidden lg:inline text-muted-foreground text-xs">Today</span>
        </div>

        {/* Pro AI for Pro and Business Users */}
        {isPaid && usage.pro.limit > 0 && (
          <>
            <span className="hidden md:inline text-muted-foreground">•</span>
            <div className="flex items-center gap-1.5">
              <span className="hidden lg:inline text-muted-foreground text-xs">Pro AI:</span>
              <Badge variant="secondary" className="text-xs font-medium">
                {usage.pro.current}/{usage.pro.limit}
              </Badge>
            </div>
          </>
        )}
      </div>

      {/* Action Button */}
      <Button
        variant={isPaid ? "ghost" : "default"}
        size="sm"
        onClick={handleBillingClick}
        className={`text-xs h-8 ${!isPaid ? 'upgrade-gradient' : ''}`}
      >
        {isPaid ? (
          <>
            <span className="hidden md:inline">Billing</span>
            <span className="md:hidden">{isBusiness ? 'Bus' : 'Pro'}</span>
          </>
        ) : (
          <>
            <span className="hidden md:inline">Upgrade</span>
            <span className="md:hidden">+</span>
          </>
        )}
      </Button>
    </div>
  );
}