'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Crown, Zap, AlertCircle } from 'lucide-react';
import useSWR from 'swr';

interface UsageData {
  subscriptionTier: 'normal' | 'pro';
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
  const { data: usage, error, mutate } = useSWR<UsageData>('/api/subscriptions/usage', fetcher, {
    refreshInterval: 30000, // Refresh every 30 seconds
    revalidateOnFocus: true,
  });

  const isPro = usage?.subscriptionTier === 'pro';
  const isNearLimit = usage && usage.normal.limit > 0 && usage.normal.remaining <= 10;

  const handleBillingClick = () => {
    router.push('/settings/billing');
  };

  // Refresh usage when AI conversations complete
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
        {isPro ? (
          <div className="flex items-center gap-1">
            <Crown className="h-4 w-4 text-yellow-500" />
            <span className="hidden md:inline font-medium">Unlimited</span>
            <span className="md:hidden font-medium">∞</span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Zap className="h-4 w-4 text-blue-500" />
            <Badge
              variant={isNearLimit ? "destructive" : "secondary"}
              className="text-xs font-medium"
            >
              {usage.normal.current}/{usage.normal.limit}
            </Badge>
            <span className="hidden lg:inline text-muted-foreground">today</span>
          </div>
        )}

        {/* Extended Thinking for Pro Users */}
        {isPro && (
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
        variant={isPro ? "ghost" : "default"}
        size="sm"
        onClick={handleBillingClick}
        className={`text-xs h-8 ${!isPro ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700' : ''}`}
      >
        {isPro ? (
          <>
            <Crown className="h-3 w-3 mr-1" />
            <span className="hidden md:inline">Billing</span>
            <span className="md:hidden">Pro</span>
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