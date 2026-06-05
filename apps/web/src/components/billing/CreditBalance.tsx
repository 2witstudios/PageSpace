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
import { formatCreditUnits, formatCreditUnitsSigned } from '@/lib/subscription/credits';

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

  const { spendable, monthly, topup, reserved, debt } = balance;
  const inDebt = spendable < 0;
  const remainingPct = monthly.allowance > 0 ? (spendable / monthly.allowance) * 100 : 0;
  const isLow = inDebt || remainingPct <= LOW_BALANCE_THRESHOLD_PCT;
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
                {formatCreditUnitsSigned(spendable, monthly.allowance)}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">
              {inDebt
                ? 'In the red — add credits to keep using AI'
                : `${formatCreditUnits(spendable, monthly.allowance)} / 100 credits remaining`}
            </p>
            {debt > 0 && (
              <p className="text-xs text-primary-foreground/80">
                Overage clears at your next renewal or with a top-up
              </p>
            )}
            {topup.remaining > 0 && (
              <p className="text-xs text-primary-foreground/80">
                +{formatCreditUnits(topup.remaining, monthly.allowance)} bonus credits from top-ups
              </p>
            )}
            {hasInFlight && (
              <p className="text-xs text-primary-foreground/80">
                ~{formatCreditUnits(reserved, monthly.allowance)} credits reserved on in-flight calls
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

      {showBilling && <BuyCreditsButton variant={isLow ? 'default' : 'ghost'} size="sm" />}
    </div>
  );
}
