'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import type { ApiClient } from '@/api/client';

/**
 * Decides whether first-run onboarding should be shown (apps/web's
 * useOnboardingGate, ported to imago's API client).
 *
 * Server state decides, not a query param: a user who refreshes part-way
 * through the flow must still see it, so nothing here keys off `?welcome=`.
 *
 * It never reports "show" while loading or after a failed read. A default of
 * "not onboarded" during load would flash the modal at every returning user.
 */

export const ONBOARDING_PATH = '/api/onboarding';

export type OnboardingGateStatus = 'loading' | 'show' | 'hide';

export interface OnboardingStateResponse {
  readonly needsOnboarding: boolean;
}

export interface CompleteOnboardingInput {
  readonly scaleLabel: string;
  readonly firstRequest: string;
}

export function useOnboardingGate(): {
  readonly status: OnboardingGateStatus;
  readonly complete: (input?: CompleteOnboardingInput) => Promise<void>;
} {
  const client: ApiClient = useApiClient();
  const { data, error, isLoading, mutate } = useSWR<OnboardingStateResponse>(
    ONBOARDING_PATH,
    (path: string) => client.apiFetch<OnboardingStateResponse>(path),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const complete = useCallback(
    async (input?: CompleteOnboardingInput) => {
      // Hide at once: the user has finished, and waiting on the network to
      // dismiss their own modal would feel broken.
      await mutate({ needsOnboarding: false }, { revalidate: false });
      try {
        await client.apiFetch(ONBOARDING_PATH, { method: 'POST', json: input ?? {} });
      } catch {
        // Deliberate, as in apps/web: the route writes memory BEFORE stamping
        // completion, so a failure here leaves the flow to reappear on a later
        // visit rather than losing what the user told us.
      }
    },
    [client, mutate],
  );

  let status: OnboardingGateStatus;
  if (isLoading) status = 'loading';
  else if (error) status = 'hide';
  else status = data?.needsOnboarding ? 'show' : 'hide';

  return { status, complete };
}
