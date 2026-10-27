'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SafeAccount } from '@pagespace/lib/agent-accounts/to-safe-account';

/** Whose accounts: the signed-in person's (their global assistant), or an agent page's. */
export type AgentAccountScope = { readonly kind: 'user' } | { readonly kind: 'agent_page'; readonly pageId: string };

export const agentAccountsUrl = (scope: AgentAccountScope) => (scope.kind === 'user' ? '/api/user/agent-accounts' : `/api/agents/${scope.pageId}/accounts`);

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch accounts: ${res.status}`);
  return res.json();
};

export function useAgentAccounts(scope: AgentAccountScope) {
  const { data, error, isLoading, mutate } = useSWR<{ configured: boolean; accounts: SafeAccount[] }>(agentAccountsUrl(scope), fetcher, { revalidateOnFocus: false });
  return { configured: data?.configured ?? true, accounts: data?.accounts ?? [], error, isLoading, mutate };
}
