'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/retained/stores/agent-workspace/useAgentWorkspaceStore';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeTarget } from '@pagespace/lib/agent-workspaces/workspace-node-wire';

/** One session row as `GET /api/agent-workspaces` lists it (the fields the session bar reads). */
export interface AgentSessionRow {
  readonly workspaceId: string;
  readonly driveId: string | null;
  readonly envId: string | null;
  readonly name: string;
  readonly sandboxStatus: 'none' | 'starting' | 'running' | 'ended';
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly conversations: ReadonlyArray<{ conversationId: string; title: string | null; agentPageId: string | null }>;
  readonly rev: number;
  readonly nodes: WorkspaceNode[];
  readonly targets: WorkspaceNodeTarget[];
}

export const sessionsKey = (driveId: string | null | undefined): string =>
  driveId ? `/api/agent-workspaces?driveId=${encodeURIComponent(driveId)}` : '/api/agent-workspaces';

async function jsonFetcher<T>(url: string): Promise<T> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

/**
 * The viewer's sessions, each one's tree seated in the workspace store on every
 * read; the store's early-out keeps an unchanged workspace from re-rendering. The
 * key and refresh policy match the Console pane's (classic's Agents sidebar), so
 * SWR shares one request between them.
 */
export function useAgentSessions(driveId: string | null | undefined, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const key = enabled ? sessionsKey(driveId) : null;
  const { data, error, isLoading, mutate } = useSWR<{ sessions: AgentSessionRow[] }>(
    key,
    jsonFetcher<{ sessions: AgentSessionRow[] }>,
    { revalidateOnFocus: false, refreshInterval: 120_000 },
  );

  useEffect(() => {
    if (!data) return;
    const store = useAgentWorkspaceStore.getState();
    for (const session of data.sessions) {
      store.hydrateFromServer(session.workspaceId, {
        rev: session.rev,
        nodes: session.nodes,
        targets: session.targets,
      });
    }
  }, [data]);

  return {
    sessions: data?.sessions ?? [],
    isLoading: enabled && isLoading && !data,
    error,
    mutate: () => void mutate(),
  };
}
