'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle } from 'lucide-react';
import useSWR from 'swr';
import { useSocketStore } from '@/stores/useSocketStore';
import type { UsageEventPayload } from '@/lib/websocket';
import { createClientLogger } from '@/lib/logging/client-logger';
import { maskIdentifier } from '@/lib/logging/mask';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';

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
  const connect = useSocketStore((state) => state.connect);
  const getSocket = useSocketStore((state) => state.getSocket);
  const { showBilling } = useBillingVisibility();

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

  // Check if near usage limits (for warning display)
  const isNearStandardLimit = usage && usage.standard.limit > 0 && usage.standard.remaining <= 10;
  const isNearProLimit = usage && usage.pro.limit > 0 && usage.pro.remaining <= 10;

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

  // Always show Standard quota when usage data is available
  const showStandardQuota = usage && usage.standard.limit > 0;
  // Show Pro quota when user has access (paid subscription with pro limit)
  const showProQuota = usage && isPaid && usage.pro.limit > 0;

  // Render quota display section
  const renderQuotaDisplay = () => {
    // Show error state (hidden on mobile)
    if (error) {
      return (
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          <span className="hidden md:inline">Usage unavailable</span>
        </div>
      );
    }

    // Show loading state while fetching usage data
    if (!usage) {
      return (
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
          <Skeleton className="h-4 w-4" />
          <span className="hidden md:inline">Loading...</span>
        </div>
      );
    }

    // Always show quota badges (hidden on mobile)
    if (showStandardQuota || showProQuota) {
      return (
        <div className="hidden sm:flex items-center gap-3 text-sm">
          {/* Standard Usage - always shown */}
          {showStandardQuota && (
            <div className="flex items-center gap-1.5">
              <span className="hidden lg:inline text-muted-foreground text-xs">Standard:</span>
              <Badge
                variant={isNearStandardLimit ? "destructive" : "secondary"}
                className="text-xs font-medium"
              >
                {usage.standard.current}/{usage.standard.limit}
              </Badge>
            </div>
          )}

          {/* Pro AI Usage - shown when user has access */}
          {showProQuota && (
            <div className="flex items-center gap-1.5">
              <span className="hidden lg:inline text-muted-foreground text-xs">Pro:</span>
              <Badge
                variant={isNearProLimit ? "destructive" : "secondary"}
                className="text-xs font-medium"
              >
                {usage.pro.current}/{usage.pro.limit}
              </Badge>
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Quota display - always shown (hidden on mobile) */}
      {renderQuotaDisplay()}

      {/* Action Button - hidden on iOS Capacitor apps (Apple App Store compliance) */}
      {showBilling && (
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
      )}
    </div>
  );
}
