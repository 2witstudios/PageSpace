'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import type { BillingProvider } from '@/lib/iap/apple-store-core';

async function fetchStatus(url: string): Promise<{ billingProvider?: BillingProvider }> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
}

export const APP_STORE_DELETION_NOTICE =
  'Deleting your account does not cancel your App Store subscription. Cancel it in your App Store subscriptions first to stop being charged.';

/**
 * On the iOS app (Apple channel), for an App Store subscriber: account
 * deletion cannot cancel an Apple-billed subscription, so say so and offer
 * Apple's Manage Subscriptions sheet. Renders nothing anywhere else.
 */
export function AppStoreSubscriptionDeletionNotice() {
  const { channel } = useBillingVisibility();
  const isApple = channel === 'apple';
  const { data } = useSWR(isApple ? '/api/subscriptions/status' : null, fetchStatus, { revalidateOnFocus: false });
  const [opening, setOpening] = useState(false);

  if (!isApple || data?.billingProvider !== 'apple') return null;

  const manage = async () => {
    setOpening(true);
    try {
      const { manageAppleSubscriptions } = await import('@/lib/iap/apple-store');
      await manageAppleSubscriptions();
    } catch (err) {
      console.error('[AppStoreSubscriptionDeletionNotice] could not open Manage Subscriptions', err);
    } finally {
      setOpening(false);
    }
  };

  return (
    <Alert className="mt-4" data-testid="app-store-deletion-notice">
      <Info className="h-4 w-4" />
      <AlertDescription className="space-y-3">
        <p>{APP_STORE_DELETION_NOTICE}</p>
        <Button variant="outline" size="sm" onClick={manage} disabled={opening}>
          {opening ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Manage Subscription
        </Button>
      </AlertDescription>
    </Alert>
  );
}
