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
import { formatCreditDollars, formatCreditDollarsSigned } from '@/lib/subscription/credits';

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

  const { spendable, monthly, topup, reserved, debt } = balance;
  // In the red: the user owes overage and can't use AI until back to positive.
  const inDebt = spendable < 0;
  const isLow = inDebt || spendable <= Math.max(LOW_BALANCE_FLOOR_CENTS, Math.round(monthly.allowance * 0.15));
  const renewalDate = monthly.periodEnd ? new Date(monthly.periodEnd) : null;
  // Surface in-flight reservations as a quiet signal, not in the headline number — the
  // displayed balance is gross of holds (see getCreditBalance) so it doesn't dip-then-pop
  // across a call; this dot just tells the user a call is currently consuming credits.
  const hasInFlight = reserved > 0;

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
              <span className="relative inline-flex">
                <Coins
                  className={`h-4 w-4 ${isLow ? 'text-amber-500' : 'text-muted-foreground'}`}
                />
                {hasInFlight && (
                  <span
                    className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500"
                    aria-hidden="true"
                  />
                )}
              </span>
              <Badge
                variant={isLow ? 'destructive' : 'secondary'}
                className="text-xs font-medium tabular-nums"
              >
                {formatCreditDollarsSigned(spendable)}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">
              {inDebt
                ? `${formatCreditDollarsSigned(spendable)} — add credits to keep using AI`
                : `${formatCreditDollars(spendable)} AI credits left`}
            </p>
            {debt > 0 && (
              <p className="text-xs text-primary-foreground/80">
                Owed: {formatCreditDollars(debt)} (cleared by a purchase or your next renewal)
              </p>
            )}
            <p className="text-xs text-primary-foreground/80">
              Monthly: {formatCreditDollars(monthly.remaining)} of{' '}
              {formatCreditDollars(monthly.allowance)}
            </p>
            <p className="text-xs text-primary-foreground/80">
              Top-up: {formatCreditDollars(topup.remaining)}
            </p>
            {hasInFlight && (
              <p className="text-xs text-primary-foreground/80">
                ~{formatCreditDollars(reserved)} reserved on in-flight calls
              </p>
            )}
            {renewalDate && (
              <p className="text-xs text-primary-foreground/80">
                Renews {renewalDate.toLocaleDateString()}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showBilling && <BuyCreditsButton variant={isLow ? 'default' : 'ghost'} size="sm" />}
    </div>
  );
}
