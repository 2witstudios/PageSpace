'use client';

/**
 * Resolves the full `AgentInfo` an `AgentView` needs from just an `agentId` —
 * the "ids address" invariant means every caller (the page view, the console)
 * holds only the id, so the component that needs the rest fetches it itself
 * rather than every caller re-deriving the same shape.
 *
 * Two existing, already-consumed endpoints — no new backend surface:
 * `GET /api/pages/:id` (title, driveId — same route CenterPanel's own
 * fallback-page fetch uses) and `GET /api/pages/:id/agent-config`
 * (systemPrompt/enabledTools/aiProvider/aiModel — the route AiChatView reads).
 * `driveName` (a required `AgentInfo` field, used by the machine pane's
 * settings display) is filled in from the already-loaded drive list rather
 * than a third fetch.
 */
import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDriveStore } from '@/hooks/useDrive';
import type { AgentInfo } from '@/types/agent';

interface PageInfoResponse {
  id: string;
  title: string | null;
  driveId: string;
}

interface AgentConfigResponse {
  systemPrompt?: string;
  enabledTools?: string[];
  aiProvider?: string;
  aiModel?: string;
}

const pageInfoFetcher = async (url: string): Promise<PageInfoResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load agent page: ${response.status}`);
  return response.json();
};

const agentConfigFetcher = async (url: string): Promise<AgentConfigResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to load agent config: ${response.status}`);
  return response.json();
};

export interface UseResolvedAgentResult {
  agent: AgentInfo | null;
  isLoading: boolean;
  error: Error | undefined;
  /** Re-fetch after a failure. SWR stops retrying on its own, so a UI that shows an error needs a way to ask again. */
  retry: () => void;
}

export function useResolvedAgent(agentId: string | null | undefined): UseResolvedAgentResult {
  const drives = useDriveStore((state) => state.drives);

  const pageKey = agentId ? `/api/pages/${encodeURIComponent(agentId)}` : null;
  const configKey = agentId ? `/api/pages/${encodeURIComponent(agentId)}/agent-config` : null;

  const {
    data: pageInfo,
    error: pageError,
    isLoading: pageLoading,
    mutate: mutatePage,
  } = useSWR(pageKey, pageInfoFetcher, { revalidateOnFocus: false, dedupingInterval: 5_000 });

  const { data: config, error: configError, mutate: mutateConfig } = useSWR(configKey, agentConfigFetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });

  const agent = useMemo<AgentInfo | null>(() => {
    if (!agentId || !pageInfo) return null;
    const drive = drives.find((d) => d.id === pageInfo.driveId);
    return {
      id: agentId,
      title: pageInfo.title || 'Untitled agent',
      driveId: pageInfo.driveId,
      driveName: drive?.name ?? '',
      systemPrompt: config?.systemPrompt,
      aiProvider: config?.aiProvider,
      aiModel: config?.aiModel,
      enabledTools: config?.enabledTools,
    };
  }, [agentId, pageInfo, config, drives]);

  const retry = useCallback(() => {
    void mutatePage();
    void mutateConfig();
  }, [mutatePage, mutateConfig]);

  return {
    agent,
    // Config is nice-to-have (defaults are fine): only the page fetch gates loading.
    isLoading: pageLoading && !agent,
    error: (pageError ?? configError) as Error | undefined,
    retry,
  };
}
