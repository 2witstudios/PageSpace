'use client';

import { useCallback } from 'react';
import useSWR, { mutate } from 'swr';
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
 * Kills a session addressed by its OWN (project, branch, name) scope — the
 * session's real identity (`machine_agent_terminals`' unique index).
 *
 * The hook's `removeAgentTerminal` below DELETEs under whatever scope the hook
 * instance was mounted with — right for undoing a spawn that same instance
 * just made, wrong for killing an arbitrary pane's session: a pane's scope can
 * differ from its workspace's (a restored server layout can hold panes bound
 * at other checkouts), and DELETEing that pane's `name` under the WORKSPACE's
 * scope would kill a different terminal that happens to share the name — or
 * nothing — while the intended one lives on as an unclaimed session.
 *
 * A 404 is SUCCESS here, not a failure: it means the session — or the
 * project/branch checkout that held it — is already gone server-side, which is
 * this call's goal state. Treating it as an error made a workspace holding a
 * stale pane permanently unremovable: the kill rejected, the confirm dialog
 * stayed open, and retrying hit the same 404 forever — an unremovable listing,
 * the exact bug class this surface exists to kill. Real failures (5xx,
 * network) still throw: the agent may genuinely still be running (and
 * billing), and silently dropping its only row would strand it. Reading the
 * status needs `fetchWithAuth` directly — the `del()` helper throws a plain
 * `Error` with no status attached (see `pushWorkspaceUpdate`'s doc in
 * useMachineWorkspaceSync for the same choice).
 *
 * Revalidates the killed scope's list afterwards so any mounted hook on that
 * scope (e.g. the sidebar's session rows) drops the dead row.
 */
export async function killAgentTerminal(
  machineId: string,
  scope: { projectName?: string | null; branchName?: string | null; name: string },
): Promise<void> {
  const query = buildQuery(machineId, scope.projectName, scope.branchName);
  const response = await fetchWithAuth(
    `/api/machines/agent-terminals?${query}&name=${encodeURIComponent(scope.name)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : 'Failed to remove terminal');
  }
  await mutate(`/api/machines/agent-terminals?${query}`);
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
