'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins } from 'lucide-react';
import { useCreditBalance } from '@/hooks/useCreditBalance';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { BuyCreditsButton } from '@/components/billing/BuyCreditsButton';
import { formatCreditCount, formatCreditCountSigned } from '@/lib/subscription/credits';

/**
 * Settings card showing the user's prepaid AI-credit balance on a 0–100 scale,
 * with a progress bar for monthly consumption and a "Buy credits" action.
 * Live-updates via `useCreditBalance`. Renders nothing when billing is disabled;
 * hides the buy action on iOS (App Store policy).
 */
export function CreditBalanceCard() {
  const { showBilling } = useBillingVisibility();
  const { balance, isLoading, isError } = useCreditBalance();

  if (!isLoading && (!balance || !balance.billingEnabled)) {
    return null;
  }

  const renewDate = balance?.monthly.periodEnd ? new Date(balance.monthly.periodEnd) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          Credits
        </CardTitle>
        <CardDescription>
          Credits power AI features. Your monthly allowance renews each billing period; purchased top-up credits never expire.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load your credit balance. Please refresh and try again.
          </p>
        ) : balance ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-3 flex-1">
              <div
                className={`text-3xl font-bold tabular-nums ${
                  balance.spendable < 0 ? 'text-red-600 dark:text-red-400' : ''
                }`}
              >
                {formatCreditCountSigned(balance.spendable)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  / {formatCreditCount(balance.monthly.allowance)} credits
                </span>
              </div>
              {balance.monthly.allowance > 0 && (
                <Progress
                  value={Math.min(
                    100,
                    Math.max(
                      0,
                      ((balance.monthly.allowance - balance.monthly.remaining) /
                        balance.monthly.allowance) *
                        100,
                    ),
                  )}
                  className="h-2"
                />
              )}
              <div className="text-sm text-muted-foreground space-y-0.5">
                {balance.debt > 0 && (
                  <div className="text-red-600 dark:text-red-400">
                    In the red — add credits to keep using AI (or it clears at your next renewal).
                  </div>
                )}
                {balance.topup.remaining > 0 && (
                  <div>
                    +{formatCreditCount(balance.topup.remaining)} bonus credits from top-ups
                  </div>
                )}
                {balance.reserved > 0 && (
                  <div>
                    ~{formatCreditCount(balance.reserved)} reserved on in-flight calls
                  </div>
                )}
                {renewDate && (
                  <div>Renews {renewDate.toLocaleDateString()}</div>
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
