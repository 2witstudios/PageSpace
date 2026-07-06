import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface OAuthGrant {
  id: string;
  clientName: string;
  scopeDescriptions: string[];
  createdAt: string;
}

const fetcher = async (url: string): Promise<OAuthGrant[]> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch connected apps');
  }
  return response.json();
};

export function useOAuthGrants() {
  const { data, error, mutate } = useSWR<OAuthGrant[]>('/api/account/oauth-grants', fetcher);

  return {
    grants: data,
    isLoading: !error && !data,
    isError: error,
    refetch: mutate,
  };
}
