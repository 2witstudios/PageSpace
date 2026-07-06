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
import { UpgradeTierButton } from '@/components/billing/UpgradeTierButton';
import { centsToCredits, formatCreditCount } from '@/lib/subscription/credits';

/** Percentage of monthly allowance remaining below which we warn the user. */
const LOW_BALANCE_THRESHOLD_PCT = 15;

export function CreditBalance() {
  const router = useRouter();
  const { showBilling } = useBillingVisibility();
  const { balance, isLoading, isError } = useCreditBalance();

  if (isLoading) {
    return (
      <div className="hidden sm:flex items-center gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-4 w-12" />
      </div>
    );
  }

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

  const { spendable, monthly, topup, reserved, debt, subscriptionTier } = balance;
  const isFree = subscriptionTier === 'free';
  const inDebt = spendable < 0;
  // Net monthly portion: gross bucket minus any outstanding debt (topup credits are separate).
  // Using monthly.remaining would overstate the balance when a lapsed period carries debt
  // (monthly.remaining holds the new allowance before debt is netted out).
  const netMonthly = spendable - topup.remaining;
  const isLow = inDebt || (monthly.allowance > 0 && netMonthly / monthly.allowance <= LOW_BALANCE_THRESHOLD_PCT / 100);
  const monthlyStr = formatCreditCount(netMonthly);
  const allowanceStr = formatCreditCount(monthly.allowance);
  const topupCredits = centsToCredits(topup.remaining);
  const topupStr = formatCreditCount(topup.remaining);
  // Surface in-flight reservations as a quiet signal, not in the headline number.
  const hasInFlight = reserved > 0;
  const renewDate = monthly.periodEnd ? new Date(monthly.periodEnd) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => router.push('/settings/usage')}
              className="hidden sm:flex items-center gap-1.5"
              aria-label="View credit balance"
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
                {monthlyStr}/{allowanceStr}
              </Badge>
              {topupCredits > 0 && (
                <>
                  <span className="text-xs text-muted-foreground font-medium">+</span>
                  <Badge variant="secondary" className="text-xs font-medium tabular-nums">
                    {topupStr}
                  </Badge>
                </>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">
              {inDebt
                ? 'In the red — add credits to keep using AI'
                : `${monthlyStr} / ${allowanceStr} credits remaining`}
            </p>
            {debt > 0 && (
              <p className="text-xs text-primary-foreground/80">
                Overage clears at your next renewal or with a top-up
              </p>
            )}
            {topupCredits > 0 && (
              <p className="text-xs text-primary-foreground/80">
                +{topupStr} bonus credits from top-ups
              </p>
            )}
            {hasInFlight && (
              <p className="text-xs text-primary-foreground/80">
                ~{formatCreditCount(reserved)} credits reserved on in-flight calls
              </p>
            )}
            {renewDate && (
              <p className="text-xs text-primary-foreground/80">
                Renews {renewDate.toLocaleDateString()}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <UpgradeTierButton isFree={isFree} />

      {showBilling && (
        <div className="hidden sm:flex">
          <BuyCreditsButton variant={isLow ? 'default' : 'ghost'} size="sm" />
        </div>
      )}
    </div>
  );
}
