'use client';

import { useCreditBalance } from '@/hooks/useCreditBalance';
import { CreditBalance } from './CreditBalance';
import { UsageCounter } from './UsageCounter';

/**
 * Navbar AI-usage widget. Picks the experience by the per-environment credits switch
 * delivered at runtime via `/api/credits` (`creditsMode`): the new `CreditBalance`
 * widget when ON, the legacy daily-quota `UsageCounter` when OFF. One `/api/credits`
 * fetch (SWR-deduped) decides the mode; each child owns its own data fetch.
 *
 * Renders nothing until the mode resolves so prod (dark-launch) never flashes a credits
 * UI it shouldn't show.
 *
 * LEGACY: collapse back to a bare <CreditBalance /> at the final credits cutover.
 */
export function AiBalanceWidget() {
  const { balance, isLoading } = useCreditBalance();
  if (isLoading || !balance) return null;
  return balance.creditsMode ? <CreditBalance /> : <UsageCounter />;
}
