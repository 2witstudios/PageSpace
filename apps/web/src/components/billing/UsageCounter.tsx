'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle } from 'lucide-react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';

/**
 * LEGACY daily-quota navbar widget — shown when the per-environment credits switch is
 * OFF (`creditsMode === false`). Restored from pre-cutover so prod keeps the old
 * "N/limit calls" experience during dark launch. Refreshes via SWR focus/visibility
 * revalidation only — the old `usage:updated` socket event was retired with the cutover
 * and is intentionally NOT resurrected.
 *
 * LEGACY: remove at final credits cutover (along with /api/subscriptions/usage).
 */

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

const fetcher = async (url: string): Promise<UsageData> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function UsageCounter() {
  const router = useRouter();
  const { showBilling } = useBillingVisibility();

  const { data: usage, error, mutate } = useSWR<UsageData>('/api/subscriptions/usage', fetcher, {
    refreshInterval: 0,
    revalidateOnFocus: true,
  });

  const isPro = usage?.subscriptionTier === 'pro';
  const isBusiness = usage?.subscriptionTier === 'business';
  const isPaid = isPro || isBusiness;

  const isNearStandardLimit = usage && usage.standard.limit > 0 && usage.standard.remaining <= 10;
  const isNearProLimit = usage && usage.pro.limit > 0 && usage.pro.remaining <= 10;

  const handleBillingClick = () => {
    router.push('/settings/billing');
  };

  // Refresh usage when the tab regains focus (covers AI calls completing in the background).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        mutate();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [mutate]);

  const showStandardQuota = usage && usage.standard.limit > 0;
  const showProQuota = usage && isPaid && usage.pro.limit > 0;

  const renderQuotaDisplay = () => {
    if (error) {
      return (
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          <span className="hidden md:inline">Usage unavailable</span>
        </div>
      );
    }

    if (!usage) {
      return (
        <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
          <Skeleton className="h-4 w-4" />
          <span className="hidden md:inline">Loading...</span>
        </div>
      );
    }

    if (showStandardQuota || showProQuota) {
      return (
        <div className="hidden sm:flex items-center gap-3 text-sm">
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
      {renderQuotaDisplay()}

      {/* Hidden on iOS Capacitor apps (Apple App Store compliance). */}
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
