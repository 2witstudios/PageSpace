'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Crown } from 'lucide-react';
import { useCreditBalance } from '@/hooks/useCreditBalance';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';

/**
 * Navbar CTA driving free-tier users toward a paid plan — buying credits alone
 * doesn't unlock premium models, so this sits next to "Buy credits" as the other
 * half of the upsell.
 */
export function UpgradeTierButton() {
  const router = useRouter();
  const { showBilling } = useBillingVisibility();
  const { balance } = useCreditBalance();

  if (!showBilling || !balance || balance.subscriptionTier !== 'free') return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => router.push('/settings/plan')}
      className="hidden sm:flex items-center gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
    >
      <Crown className="h-4 w-4" />
      Upgrade
    </Button>
  );
}
