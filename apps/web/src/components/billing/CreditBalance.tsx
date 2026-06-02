'use client';

import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AlertCircle, Coins } from 'lucide-react';
import { useCreditBalance } from '@/hooks/useCreditBalance';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { BuyCreditsButton } from '@/components/billing/BuyCreditsButton';
import { formatCreditDollars } from '@/lib/subscription/credits';

/** Whole cents below which we visually warn the user their balance is running low. */
const LOW_BALANCE_FLOOR_CENTS = 50;

/**
 * Header widget showing the user's remaining prepaid AI credits and a "Buy credits"
 * action. Replaces the retired per-day usage counter. Live-updates from
 * `credits:updated` socket events via `useCreditBalance`. Hidden entirely on
 * billing-disabled deployments; the buy action is hidden on iOS (App Store policy).
 */
export function CreditBalance() {
  const router = useRouter();
  const { showBilling } = useBillingVisibility();
  const { balance, isLoading, isError } = useCreditBalance();

  // Loading state (hidden on mobile to save space).
  if (isLoading) {
    return (
      <div className="hidden sm:flex items-center gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-12" />
      </div>
    );
  }

  // Error or billing disabled: render nothing rather than a broken widget.
  if (isError || !balance || !balance.billingEnabled) {
    if (isError) {
      return (
        <div className="hidden sm:flex items-center gap-1.5 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          <span className="hidden md:inline">Credits unavailable</span>
        </div>
      );
    }
    return null;
  }

  const { spendable, monthly, topup } = balance;
  const isLow = spendable <= Math.max(LOW_BALANCE_FLOOR_CENTS, Math.round(monthly.allowance * 0.15));
  const resetDate = monthly.periodEnd ? new Date(monthly.periodEnd) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => router.push('/settings/billing')}
              className="hidden sm:flex items-center gap-1.5"
              aria-label="View AI credit balance"
            >
              <Coins
                className={`h-4 w-4 ${isLow ? 'text-amber-500' : 'text-muted-foreground'}`}
              />
              <Badge
                variant={isLow ? 'destructive' : 'secondary'}
                className="text-xs font-medium tabular-nums"
              >
                {formatCreditDollars(spendable)}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{formatCreditDollars(spendable)} AI credits left</p>
            <p className="text-xs text-muted-foreground">
              Monthly: {formatCreditDollars(monthly.remaining)} of{' '}
              {formatCreditDollars(monthly.allowance)}
            </p>
            <p className="text-xs text-muted-foreground">
              Top-up: {formatCreditDollars(topup.remaining)}
            </p>
            {resetDate && (
              <p className="text-xs text-muted-foreground">
                Monthly resets {resetDate.toLocaleDateString()}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showBilling && <BuyCreditsButton variant={isLow ? 'default' : 'ghost'} size="sm" />}
    </div>
  );
}
