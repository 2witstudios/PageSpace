'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CreditCard, Loader2 } from 'lucide-react';
import { post } from '@/lib/auth/auth-fetch';
import {
  CREDIT_PACK_LIST,
  formatCreditDollars,
  TOPUP_MIN_CENTS,
  TOPUP_MAX_CENTS,
} from '@/lib/subscription/credits';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';

interface BuyCreditsButtonProps {
  /** Visual variant for the trigger button. */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  /** Override the trigger label (defaults to "Buy credits"). */
  label?: string;
}

/** Body for the top-up checkout: either a fixed pack id or a custom whole-cent amount. */
type TopupBody = { packId: string } | { amountCents: number };

/**
 * "Buy credits" trigger that opens a menu of top-up packs (sourced from `CREDIT_PACKS`
 * via the in-app credits helper) PLUS a custom-amount field, and starts a one-time
 * Stripe Checkout session for the chosen amount, redirecting to the hosted page. On
 * success the webhook funds the user's top-up bucket (paying down any debt first);
 * Stripe returns the user to `/settings/billing?credits=success`.
 */
export function BuyCreditsButton({
  variant = 'default',
  size = 'sm',
  className,
  label = 'Buy credits',
}: BuyCreditsButtonProps) {
  const { showBilling } = useBillingVisibility();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customDollars, setCustomDollars] = useState('');

  const startCheckout = async (body: TopupBody, key: string) => {
    setLoadingKey(key);
    setError(null);
    try {
      const { url } = await post<{ url: string }>('/api/stripe/create-credit-topup', body);
      if (url) {
        window.location.href = url;
      } else {
        setError('Could not start checkout. Please try again.');
        setLoadingKey(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout. Please try again.');
      setLoadingKey(null);
    }
  };

  const handleBuyCustom = () => {
    const dollars = Number.parseFloat(customDollars);
    if (!Number.isFinite(dollars)) {
      setError('Enter a dollar amount.');
      return;
    }
    const cents = Math.round(dollars * 100);
    if (cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
      setError(
        `Enter an amount between ${formatCreditDollars(TOPUP_MIN_CENTS)} and ${formatCreditDollars(TOPUP_MAX_CENTS)}.`,
      );
      return;
    }
    void startCheckout({ amountCents: cents }, 'custom');
  };

  const isLoading = loadingKey !== null;

  // Hide on iOS Capacitor (App Store policy — no in-app Stripe purchases) and on
  // billing-disabled deployments. Self-hiding here keeps every call site compliant,
  // including the out-of-credits chat error CTAs.
  if (!showBilling) return null;

  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CreditCard className="h-4 w-4 mr-2" />
            )}
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Add AI credits</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CREDIT_PACK_LIST.map((pack) => (
            <DropdownMenuItem
              key={pack.id}
              disabled={isLoading}
              onSelect={(e) => {
                e.preventDefault();
                void startCheckout({ packId: pack.id }, pack.id);
              }}
            >
              {loadingKey === pack.id ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              {formatCreditDollars(pack.cents)} credits
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Or a custom amount ({formatCreditDollars(TOPUP_MIN_CENTS)}–
            {formatCreditDollars(TOPUP_MAX_CENTS)})
          </DropdownMenuLabel>
          {/* Plain content (not a DropdownMenuItem) so interacting doesn't close the
              menu; stop keydown propagation so Radix typeahead doesn't hijack typing. */}
          <div
            className="flex items-center gap-2 px-2 py-1.5"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              inputMode="decimal"
              min={TOPUP_MIN_CENTS / 100}
              max={TOPUP_MAX_CENTS / 100}
              step="1"
              placeholder="25"
              value={customDollars}
              onChange={(e) => setCustomDollars(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleBuyCustom();
                }
              }}
              className="h-8 w-24"
              disabled={isLoading}
            />
            <Button
              size="sm"
              className="h-8"
              disabled={isLoading || customDollars.trim() === ''}
              onClick={handleBuyCustom}
            >
              {loadingKey === 'custom' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
