'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';
import type { AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';

export interface AgentTerminal {
  name: string;
  agentType: AgentRuntimeType;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch terminals');
    }
    return res.json() as Promise<{ agentTerminals: AgentTerminal[] }>;
  });

/** Runtime tier of the Terminal workspace navigator — named, pluggable-agent-typed PTY sessions in a branch's Sprite. */
export function useAgentTerminals(terminalId: string | null, projectName: string | null, branchName: string | null) {
  const key =
    terminalId && projectName && branchName
      ? `/api/machines/agent-terminals?terminalId=${encodeURIComponent(terminalId)}&projectName=${encodeURIComponent(projectName)}&branchName=${encodeURIComponent(branchName)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addAgentTerminal = useCallback(
    async (name: string, agentType: AgentRuntimeType) => {
      if (!terminalId || !projectName || !branchName) throw new Error('No active branch');
      const result = await post<{ agentTerminal: { name: string; agentType: AgentRuntimeType; resumed: boolean } }>(
        '/api/machines/agent-terminals',
        { terminalId, projectName, branchName, name, agentType },
      );
      await mutate();
      return result.agentTerminal;
    },
    [terminalId, projectName, branchName, mutate],
  );

  const removeAgentTerminal = useCallback(
    async (name: string) => {
      if (!terminalId || !projectName || !branchName) throw new Error('No active branch');
      await del(
        `/api/machines/agent-terminals?terminalId=${encodeURIComponent(terminalId)}&projectName=${encodeURIComponent(projectName)}&branchName=${encodeURIComponent(branchName)}&name=${encodeURIComponent(name)}`,
      );
      await mutate();
    },
    [terminalId, projectName, branchName, mutate],
  );

  return {
    agentTerminals: data?.agentTerminals ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
    addAgentTerminal,
    removeAgentTerminal,
  };
}
