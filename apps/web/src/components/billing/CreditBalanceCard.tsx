'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins } from 'lucide-react';
import { useCreditBalance } from '@/hooks/useCreditBalance';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { BuyCreditsButton } from '@/components/billing/BuyCreditsButton';
import { formatCreditDollars } from '@/lib/subscription/credits';

/**
 * Settings card showing the user's prepaid AI-credit balance: the monthly allowance
 * bucket (resets each period), the never-expiring top-up bucket, and a "Buy credits"
 * action. Live-updates via `useCreditBalance`. Renders nothing when billing is
 * disabled; hides the buy action on iOS (App Store policy).
 */
export function CreditBalanceCard() {
  const { showBilling } = useBillingVisibility();
  const { balance, isLoading, isError } = useCreditBalance();

  // Hidden on billing-disabled deployments.
  if (!isLoading && (!balance || !balance.billingEnabled)) {
    return null;
  }

  const resetDate = balance?.monthly.periodEnd ? new Date(balance.monthly.periodEnd) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          AI Credits
        </CardTitle>
        <CardDescription>
          Credits power AI features and are billed at usage. Your monthly allowance
          resets each period; purchased top-up credits never expire.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load your credit balance. Please refresh and try again.
          </p>
        ) : balance ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-2">
              <div className="text-3xl font-bold tabular-nums">
                {formatCreditDollars(balance.spendable)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">available</span>
              </div>
              <div className="text-sm text-muted-foreground space-y-0.5">
                <div>
                  Monthly allowance: {formatCreditDollars(balance.monthly.remaining)} of{' '}
                  {formatCreditDollars(balance.monthly.allowance)}
                  {resetDate && <> · resets {resetDate.toLocaleDateString()}</>}
                </div>
                <div>Top-up balance: {formatCreditDollars(balance.topup.remaining)}</div>
                {balance.reserved > 0 && (
                  <div>Reserved (in-flight): {formatCreditDollars(balance.reserved)}</div>
                )}
              </div>
            </div>
            {showBilling && <BuyCreditsButton variant="default" size="default" />}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
