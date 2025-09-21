'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Crown, Zap, AlertCircle } from 'lucide-react';
import useSWR from 'swr';
import { useSocketStore } from '@/stores/socketStore';
import type { UsageEventPayload } from '@/lib/socket-utils';

interface UsageData {
  subscriptionTier: 'normal' | 'pro' | 'business';
  normal: {
    current: number;
    limit: number;
    remaining: number;
  };
  extraThinking: {
    current: number;
    limit: number;
    remaining: number;
  };
}

const fetcher = (url: string) => fetch(url).then(res => res.json());

export function UsageCounter() {
  const router = useRouter();
  const { connect, getSocket } = useSocketStore();
  const { data: usage, error, mutate } = useSWR<UsageData>('/api/subscriptions/usage', fetcher, {
    refreshInterval: 30000, // Refresh every 30 seconds
    revalidateOnFocus: true,
  });

  const isPro = usage?.subscriptionTier === 'pro';
  const isBusiness = usage?.subscriptionTier === 'business';
  const isPaid = isPro || isBusiness;
  const isNearLimit = usage && usage.normal.limit > 0 && usage.normal.remaining <= 10;

  const handleBillingClick = () => {
    router.push('/settings/billing');
  };

  // Connect to Socket.IO and listen for usage events
  useEffect(() => {
    connect();
    const socket = getSocket();

    if (socket) {
      const handleUsageUpdated = (payload: UsageEventPayload) => {
        console.log('🔔 Received usage update:', payload);

        // Update SWR cache with new usage data
        mutate({
          subscriptionTier: payload.subscriptionTier,
          normal: payload.normal,
          extraThinking: payload.extraThinking
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
    <div className="flex items-center gap-2">
      {/* Usage Display */}
      <div className="flex items-center gap-2 text-sm">
        <div className="flex items-center gap-1">
          {isPaid ? (
            <Crown className="h-4 w-4 text-yellow-500" />
          ) : (
            <Zap className="h-4 w-4 text-blue-500" />
          )}
          <Badge
            variant={isNearLimit ? "destructive" : "secondary"}
            className="text-xs font-medium"
          >
            {usage.normal.current}/{usage.normal.limit}
          </Badge>
          <span className="hidden lg:inline text-muted-foreground">today</span>
        </div>

        {/* Extended Thinking for Pro and Business Users */}
        {isPaid && usage.extraThinking.limit > 0 && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="hidden md:inline">•</span>
            <Crown className="h-3 w-3 text-yellow-500" />
            <Badge variant="secondary" className="text-xs">
              {usage.extraThinking.current}/{usage.extraThinking.limit}
            </Badge>
            <span className="hidden lg:inline text-xs">thinking</span>
          </div>
        )}
      </div>

      {/* Action Button */}
      <Button
        variant={isPaid ? "ghost" : "default"}
        size="sm"
        onClick={handleBillingClick}
        className={`text-xs h-8 ${!isPaid ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700' : ''}`}
      >
        {isPaid ? (
          <>
            <Crown className="h-3 w-3 mr-1" />
            <span className="hidden md:inline">Billing</span>
            <span className="md:hidden">{isBusiness ? 'Bus' : 'Pro'}</span>
          </>
        ) : (
          <>
            <Crown className="h-3 w-3 mr-1" />
            <span className="hidden md:inline">Upgrade</span>
            <span className="md:hidden">+</span>
          </>
        )}
      </Button>
    </div>
  );
}