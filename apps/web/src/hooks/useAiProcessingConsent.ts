import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';

interface AiConsentResponse {
  consented: boolean;
  policyVersion: number;
  consentedAt: string | null;
}

const ENDPOINT = '/api/consent/ai-processing';

const fetcher = async (url: string): Promise<AiConsentResponse> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch AI processing consent');
  return res.json();
};

/**
 * Reads + mutates the user's AI-processing consent (GDPR Art 13(1)(e)(f), 44).
 * The validity/shaping rules live server-side in the pure consent core; this hook is
 * a thin client over the route.
 */
export function useAiProcessingConsent() {
  const { data, error, isLoading, mutate } = useSWR<AiConsentResponse>(ENDPOINT, fetcher, {
    revalidateOnFocus: false,
  });

  const grant = async () => {
    await post(ENDPOINT, {});
    await mutate();
  };

  const revoke = async () => {
    await del(ENDPOINT);
    await mutate();
  };

  return {
    consented: data?.consented ?? false,
    consentedAt: data?.consentedAt ?? null,
    isLoading,
    error,
    grant,
    revoke,
    mutate,
  };
}
