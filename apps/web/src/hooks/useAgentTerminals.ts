'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';
import type { AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';

export interface AgentTerminal {
  name: string;
  // A raw DB value, not narrowed to AgentRuntimeType — a row can carry an
  // agentType from a since-retired AGENT_LAUNCH_SPECS entry (e.g. the removed
  // 'pagespace-cli'). Callers check `isAgentRuntimeType(agentType)` before
  // treating it as a launchable one (see WorkspaceLeaves.tsx).
  agentType: string;
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

function buildQuery(machineId: string, projectName?: string | null, branchName?: string | null): string {
  const params = new URLSearchParams({ machineId });
  if (projectName) params.set('projectName', projectName);
  if (branchName) params.set('branchName', branchName);
  return params.toString();
}

/**
 * Runtime tier of the Terminal workspace navigator — named, pluggable-agent-
 * typed PTY sessions at ANY of the three universal Terminal scopes: neither
 * `projectName` nor `branchName` set targets machine scope, `projectName`
 * alone targets project scope, both set targets branch scope. Pass a `null`
 * `machineId` to disable fetching entirely (e.g. a collapsed navigator node).
 */
export function useAgentTerminals(machineId: string | null, projectName?: string | null, branchName?: string | null) {
  const key = machineId ? `/api/machines/agent-terminals?${buildQuery(machineId, projectName, branchName)}` : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addAgentTerminal = useCallback(
    async (name: string, agentType: AgentRuntimeType) => {
      if (!machineId) throw new Error('No active machine');
      const result = await post<{ agentTerminal: { name: string; agentType: AgentRuntimeType; resumed: boolean } }>(
        '/api/machines/agent-terminals',
        { machineId, projectName: projectName ?? undefined, branchName: branchName ?? undefined, name, agentType },
      );
      await mutate();
      return result.agentTerminal;
    },
    [machineId, projectName, branchName, mutate],
  );

  const removeAgentTerminal = useCallback(
    async (name: string) => {
      if (!machineId) throw new Error('No active machine');
      await del(`/api/machines/agent-terminals?${buildQuery(machineId, projectName, branchName)}&name=${encodeURIComponent(name)}`);
      await mutate();
    },
    [machineId, projectName, branchName, mutate],
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
