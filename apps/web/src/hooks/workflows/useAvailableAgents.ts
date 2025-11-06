'use client';

import useSWR from 'swr';

interface AgentPage {
  id: string;
  title: string;
  driveId: string;
}

interface UseAvailableAgentsResult {
  agents: AgentPage[];
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
}

const fetcher = async (url: string): Promise<AgentPage[]> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch available agents');
  }
  const data = await res.json();
  return data.agents || [];
};

export function useAvailableAgents(
  driveId?: string | null
): UseAvailableAgentsResult {
  const url = driveId
    ? `/api/workflows/agents?driveId=${driveId}`
    : '/api/workflows/agents';

  const { data, error, isLoading } = useSWR<AgentPage[]>(url, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  return {
    agents: data ?? [],
    isLoading,
    isError: !!error,
    error,
  };
}
