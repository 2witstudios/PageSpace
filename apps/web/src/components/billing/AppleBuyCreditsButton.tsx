'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Coins, Loader2 } from 'lucide-react';
import { useAppleProducts } from '@/hooks/useAppleProducts';
import { purchaseResultMessage } from '@/lib/iap/apple-store-core';
import { centsFromCredits, formatCreditCount } from '@/lib/subscription/credits';

interface AppleBuyCreditsButtonProps {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;
  label?: string;
  /** Whether the user is on the free tier (adds the upgrade hint). */
  isFree: boolean;
}

/**
 * "Buy credits" on the Apple billing channel: the three App Store credit packs
 * at StoreKit's localized prices, bought through In-App Purchase. No custom
 * amount — that is a web-only (Stripe) top-up.
 */
export function AppleBuyCreditsButton({
  variant = 'default',
  size = 'sm',
  className,
  label = 'Buy credits',
  isFree,
}: AppleBuyCreditsButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { creditPacks, isLoading, isError } = useAppleProducts(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'error'; text: string } | null>(null);

  const buy = async (productId: string) => {
    setBuying(productId);
    setNotice(null);
    try {
      const { purchaseAppleProduct } = await import('@/lib/iap/apple-store');
      setNotice(purchaseResultMessage(await purchaseAppleProduct(productId)));
    } finally {
      setBuying(null);
    }
  };

  const busy = buying !== null;

  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Coins className="h-4 w-4 mr-2" />}
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <div className="flex items-center justify-between px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
            <DropdownMenuLabel className="p-0">Add credits</DropdownMenuLabel>
            {pathname !== '/settings/usage' && (
              <button
                type="button"
                onClick={() => router.push('/settings/usage')}
                className="text-xs text-muted-foreground hover:underline"
              >
                View usage →
              </button>
            )}
          </div>
          <DropdownMenuSeparator />
          {isLoading && (
            <DropdownMenuItem disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Loading…
            </DropdownMenuItem>
          )}
          {!isLoading && creditPacks.length === 0 && (
            <DropdownMenuItem disabled>
              {isError ? 'The App Store is unavailable right now.' : 'Credit packs are not available right now.'}
            </DropdownMenuItem>
          )}
          {creditPacks.map((pack) => (
            <DropdownMenuItem
              key={pack.productId}
              disabled={busy}
              onSelect={(e) => {
                e.preventDefault();
                void buy(pack.productId);
              }}
            >
              {buying === pack.productId ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Coins className="h-4 w-4 mr-2" />
              )}
              {pack.kind === 'consumable' ? `${formatCreditCount(centsFromCredits(pack.credits))} credits` : pack.displayName}
              <span className="ml-auto pl-4 text-xs text-muted-foreground">{pack.displayPrice}</span>
            </DropdownMenuItem>
          ))}
          {isFree && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-2 flex items-center justify-between gap-2 rounded-sm bg-primary/5">
                <p className="text-xs text-muted-foreground">Free plan — premium models need a paid plan.</p>
                <button
                  type="button"
                  onClick={() => router.push('/settings/plan')}
                  className="text-xs font-medium text-primary hover:underline shrink-0"
                >
                  Upgrade →
                </button>
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {notice && (
        <p
          className={`mt-1 text-xs ${notice.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
          role="status"
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
