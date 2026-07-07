'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  description?: string;
  language?: string;
  private?: boolean;
}

type ReposResponse = { connected: false } | { connected: true; repos: GithubRepo[]; page: number };

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch GitHub repos');
    }
    return res.json() as Promise<ReposResponse>;
  });

/**
 * Backs the Terminal Navigator's "Add project" repo picker — the connected
 * user's own GitHub repos, fetched only while the dialog housing the picker
 * is open (pass `enabled: false` otherwise).
 */
export function useGithubRepos(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR(
    enabled ? '/api/integrations/github/repos' : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  return {
    repos: data?.connected ? data.repos : [],
    // null while unresolved (still loading or not yet fetched) — the dialog
    // treats that as neither "picker" nor "connect CTA" to avoid a flash of
    // the wrong state.
    connected: data?.connected ?? null,
    isLoading,
    error: error as Error | undefined,
    // Callers (e.g. the "Connect GitHub" success handler) can force a refetch
    // — the SWR key doesn't change across a connect/disconnect cycle, so
    // without this the cached `connected: false` would never refresh.
    mutate,
  };
}
