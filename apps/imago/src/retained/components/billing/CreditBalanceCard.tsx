'use client';

import { Skeleton } from '@/retained/components/ui/skeleton';
import { SettingsSection } from '@/ui/settings/settings-screen/settings-screen';
import { useCreditBalance } from '@/retained/hooks/useCreditBalance';
import { useBillingVisibility } from '@/retained/hooks/useBillingVisibility';
import { BuyCreditsButton } from '@/retained/components/billing/BuyCreditsButton';
import { UpgradeTierButton } from '@/retained/components/billing/UpgradeTierButton';
import { creditBalanceCopy, formatWholeCredits } from '@/retained/lib/subscription/credits';
import { nextGrantOf } from '@/lib/credits/next-grant';

/**
 * Settings card showing the user's AI-credit balance: every spendable credit as
 * one total and, on a paid tier, the allowance the next period adds. Credits roll
 * over (each period adds the allowance to what is left) and top-ups never expire,
 * so there is no "used of allowance" meter.
 * Live-updates via `useCreditBalance`. Renders nothing when billing is disabled;
 * hides the buy action on iOS (App Store policy).
 */
export function CreditBalanceCard() {
  const { showBilling } = useBillingVisibility();
  const { balance, isLoading, isError } = useCreditBalance();

  if (!isLoading && (!balance || !balance.billingEnabled)) {
    return null;
  }

  const isFree = balance?.subscriptionTier === 'free';
  // The allowance less any debt, paid tiers only: the same promise the account menu makes.
  const nextGrant = nextGrantOf(balance);
  const copy = creditBalanceCopy({ isFree, showBilling });

  return (
    <SettingsSection
      title="Credit balance"
      description={copy.description}
      actions={
        balance ? (
          <div className="flex items-center gap-2">
            <UpgradeTierButton isFree={isFree} className="flex" />
            {showBilling && <BuyCreditsButton variant="default" size="default" />}
          </div>
        ) : undefined
      }
    >
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
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={`text-3xl font-bold tabular-nums ${
                balance.spendable < 0 ? 'text-red-600 dark:text-red-400' : ''
              }`}
            >
              {formatWholeCredits(balance.spendable)}
            </span>
            <span className="text-sm text-muted-foreground">credits</span>
          </div>
          <div className="space-y-0.5 text-sm text-muted-foreground">
            {nextGrant && (
              <div>
                {formatWholeCredits(nextGrant.cents)} more on {nextGrant.on}
              </div>
            )}
            {balance.debt > 0 && (
              <div className="text-red-600 dark:text-red-400">{copy.inDebt}</div>
            )}
            {balance.topup.remaining > 0 && (
              <div>Includes {formatWholeCredits(balance.topup.remaining)} from top-ups</div>
            )}
            {balance.reserved > 0 && (
              <div>~{formatWholeCredits(balance.reserved)} reserved on in-flight calls</div>
            )}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
