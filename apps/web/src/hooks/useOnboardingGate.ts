import { useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';

/**
 * Decides whether first-run onboarding should be shown.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It does not key off `?welcome=true`. That param is written by every auth
 *    route on first signup, but a user who refreshes part-way through the flow
 *    loses it — and would then be stranded in an empty workspace with the
 *    explanation gone. Server state decides; the param is only cleaned up.
 *
 * 2. It never reports "show" while it is still loading. A hook that defaults to
 *    a falsy value during load would flash the modal at every returning user on
 *    every page load, which is exactly the bug `useDisplayPreferences` would
 *    have inherited (it returns all-`false` while loading and on error, which is
 *    indistinguishable from "not yet onboarded").
 */

export type OnboardingGateStatus = 'loading' | 'show' | 'hide';

interface OnboardingStateResponse {
  needsOnboarding: boolean;
}

const fetcher = async (url: string): Promise<OnboardingStateResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to load onboarding state');
  return response.json();
};

export interface CompleteOnboardingInput {
  scaleLabel: string;
  firstRequest: string;
}

export function useOnboardingGate() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, error, isLoading, mutate } = useSWR<OnboardingStateResponse>(
    '/api/onboarding',
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  // Clean the URL once, without adding a history entry. Done regardless of the
  // gate's answer so a returning user who somehow lands with the param does not
  // keep it in their address bar.
  useEffect(() => {
    if (searchParams.get('welcome') === null) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete('welcome');
    const query = next.toString();
    router.replace(query ? `?${query}` : window.location.pathname, { scroll: false });
  }, [searchParams, router]);

  const complete = useCallback(
    async (input?: CompleteOnboardingInput) => {
      // Hide immediately — the user has finished, and waiting on the network to
      // dismiss their own modal would feel broken.
      await mutate({ needsOnboarding: false }, { revalidate: false });
      try {
        await post('/api/onboarding', input ?? {});
      } catch {
        // Swallowed on purpose: completion is recorded server-side on a best
        // effort basis, and re-opening the modal because the write failed would
        // be worse than showing it once more on a later visit.
      }
    },
    [mutate],
  );

  let status: OnboardingGateStatus;
  if (isLoading) status = 'loading';
  else if (error) status = 'hide'; // never onboard on the strength of a failed read
  else status = data?.needsOnboarding ? 'show' : 'hide';

  return { status, complete };
}
