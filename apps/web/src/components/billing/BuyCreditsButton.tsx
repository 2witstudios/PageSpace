'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { CREDIT_PACK_LIST, formatCreditDollars } from '@/lib/subscription/credits';

interface BuyCreditsButtonProps {
  /** Visual variant for the trigger button. */
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  /** Override the trigger label (defaults to "Buy credits"). */
  label?: string;
}

/**
 * "Buy credits" trigger that opens a menu of top-up packs (sourced from
 * `CREDIT_PACKS` via the in-app credits helper) and starts a one-time Stripe
 * Checkout session for the chosen pack, redirecting to the hosted page. On success
 * the webhook funds the user's top-up bucket; Stripe returns the user to
 * `/settings/billing?credits=success`.
 */
export function BuyCreditsButton({
  variant = 'default',
  size = 'sm',
  className,
  label = 'Buy credits',
}: BuyCreditsButtonProps) {
  const [loadingPackId, setLoadingPackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleBuy = async (packId: string) => {
    setLoadingPackId(packId);
    setError(null);
    try {
      const { url } = await post<{ url: string }>('/api/stripe/create-credit-topup', { packId });
      if (url) {
        window.location.href = url;
      } else {
        setError('Could not start checkout. Please try again.');
        setLoadingPackId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout. Please try again.');
      setLoadingPackId(null);
    }
  };

  const isLoading = loadingPackId !== null;

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
                void handleBuy(pack.id);
              }}
            >
              {loadingPackId === pack.id ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              {formatCreditDollars(pack.cents)} credits
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
