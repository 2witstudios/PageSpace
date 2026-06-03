'use client';

import { useCreditBalance } from '@/hooks/useCreditBalance';

/**
 * The per-environment credits switch, delivered to the client at runtime via the
 * `/api/credits` payload (`creditsMode`). When true the app shows the new credits UI +
 * enforcement; when false it shows the legacy daily-quota UI. Reuses the SWR-deduped
 * `useCreditBalance` fetch, so adding this hook costs no extra request.
 *
 * Defaults to **false (legacy)** until the fetch resolves so a slow/failed `/api/credits`
 * never flashes a credits UI that prod (dark-launch) shouldn't show.
 */
export function useCreditsMode(): boolean {
  const { balance } = useCreditBalance();
  return balance?.creditsMode ?? false;
}
