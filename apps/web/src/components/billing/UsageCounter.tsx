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
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';

const usageLogger = createClientLogger({ namespace: 'usage', component: 'usage-counter' });

// PageSpace model identifiers
const PAGESPACE_STANDARD_MODEL = 'glm-4.5-air';
const PAGESPACE_PRO_MODEL = 'glm-4.6';

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

  // Get current AI provider/model selection and ensure settings are loaded
  const currentProvider = useAssistantSettingsStore(state => state.currentProvider);
  const currentModel = useAssistantSettingsStore(state => state.currentModel);
  const loadSettings = useAssistantSettingsStore(state => state.loadSettings);

  // Load assistant settings on mount if not already loaded
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Determine which quota type to show based on selected model
  // Only show quota when provider is explicitly 'pagespace' (not null/unloaded)
  const isPageSpaceProvider = currentProvider === 'pagespace';
  const isStandardModel = currentModel === PAGESPACE_STANDARD_MODEL;
  const isProModel = currentModel === PAGESPACE_PRO_MODEL;

  const { data: usage, error, mutate } = useSWR<UsageData>('/api/subscriptions/usage', fetcher, {
    refreshInterval: 0, // Disabled - rely on Socket.IO for real-time updates
    revalidateOnFocus: false, // Don't revalidate on tab focus (prevents interruptions)
    isPaused: () => isAnyActive, // Pause revalidation during editing/streaming
  });

  const isPro = usage?.subscriptionTier === 'pro';
  const isBusiness = usage?.subscriptionTier === 'business';
  const isPaid = isPro || isBusiness;

  // Check near limit based on which model is selected
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

  // Show Pro quota when Pro model is selected (and user has access)
  const showProQuota = isPageSpaceProvider && isProModel && isPaid && usage && usage.pro.limit > 0;
  // Show Standard quota when Standard model is selected
  const showStandardQuota = isPageSpaceProvider && isStandardModel && usage;

  // Render quota display section (only for PageSpace models with loaded usage data)
  const renderQuotaDisplay = () => {
    // Show error state
    if (error) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          <span className="hidden md:inline">Usage unavailable</span>
        </div>
      );
    }

    // Show loading state only for PageSpace provider
    if (isPageSpaceProvider && !usage) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-pulse bg-muted rounded" />
          <span className="hidden md:inline">Loading...</span>
        </div>
      );
    }

    // Show quota badges for PageSpace models
    if (showStandardQuota || showProQuota) {
      return (
        <div className="flex items-center gap-3 text-sm">
          {/* Standard Usage - only when Standard model selected */}
          {showStandardQuota && (
            <div className="flex items-center gap-1.5">
              <span className="hidden lg:inline text-muted-foreground text-xs">Standard:</span>
              <Badge
                variant={isNearStandardLimit ? "destructive" : "secondary"}
                className="text-xs font-medium"
              >
                {usage.standard.current}/{usage.standard.limit}
              </Badge>
              <span className="hidden lg:inline text-muted-foreground text-xs">Today</span>
            </div>
          )}

          {/* Pro AI Usage - only when Pro model selected */}
          {showProQuota && (
            <div className="flex items-center gap-1.5">
              <span className="hidden lg:inline text-muted-foreground text-xs">Pro AI:</span>
              <Badge
                variant={isNearProLimit ? "destructive" : "secondary"}
                className="text-xs font-medium"
              >
                {usage.pro.current}/{usage.pro.limit}
              </Badge>
              <span className="hidden lg:inline text-muted-foreground text-xs">Today</span>
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Quota display - conditional based on provider/model */}
      {renderQuotaDisplay()}

      {/* Action Button - always visible for billing navigation */}
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