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
 * Renders nothing only on the very first load (no cached balance yet) so prod
 * (dark-launch) never flashes a credits UI it shouldn't show. If `/api/credits` then
 * errors or never resolves the mode, we fall back to the legacy `UsageCounter` — OFF is
 * the safe default, and that widget fetches `/api/subscriptions/usage` independently, so
 * a credits-endpoint outage can't blank the navbar in a credits-mode-OFF environment.
 *
 * LEGACY: collapse back to a bare <CreditBalance /> at the final credits cutover.
 */
export function AiBalanceWidget() {
  const { balance, isLoading } = useCreditBalance();
  // Initial load with no data yet: render nothing briefly to avoid a wrong-widget flash.
  if (isLoading && !balance) return null;
  // OFF is the safe default: when the mode is unknown (error / not yet resolved),
  // `balance?.creditsMode` is falsy and we show the legacy quota widget, not nothing.
  return balance?.creditsMode ? <CreditBalance /> : <UsageCounter />;
}
