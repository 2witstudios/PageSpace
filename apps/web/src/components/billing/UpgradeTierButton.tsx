'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { PLANS } from '@/lib/subscription/plans';
import { cn } from '@/lib/utils';

interface UpgradeTierButtonProps {
  /** Whether the current user is on the free tier — the only tier this CTA targets. */
  isFree: boolean;
  /** Merged over the default classes — e.g. to drop the navbar's `hidden sm:flex` collapsing on a full-width surface. */
  className?: string;
}

const UpgradeIcon = PLANS.pro.icon;

/**
 * Navbar CTA driving free-tier users toward a paid plan — buying credits alone
 * doesn't unlock premium models, so this sits next to "Buy credits" as the other
 * half of the upsell. Takes tier as a prop rather than fetching its own balance:
 * its sole caller (CreditBalance) already holds it after resolving showBilling/
 * billingEnabled, so a second useCreditBalance() instance here would just add a
 * redundant SWR/socket subscription for data the parent already has.
 */
export function UpgradeTierButton({ isFree, className }: UpgradeTierButtonProps) {
  const router = useRouter();

  if (!isFree) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => router.push('/settings/plan')}
      className={cn(
        'hidden sm:flex items-center gap-1.5 border-primary/30 text-primary hover:bg-primary/10',
        className,
      )}
    >
      <UpgradeIcon className="h-4 w-4" />
      Upgrade
    </Button>
  );
}
