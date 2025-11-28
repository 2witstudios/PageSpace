import useSWR from 'swr';
import { useMemo } from 'react';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { AgentInfo } from '@/stores/page-agents/usePageAgentDashboardStore';

/**
 * Agent summary from the multi-drive API
 */
export interface AgentSummary {
  id: string;
  title: string | null;
  parentId: string;
  position: number;
  aiProvider: string;
  aiModel: string;
  hasWelcomeMessage: boolean;
  createdAt: string;
  updatedAt: string;
  driveId: string;
  driveName: string;
  driveSlug: string;
  systemPrompt?: string;
  systemPromptPreview?: string;
  enabledTools?: string[];
  enabledToolsCount?: number;
  hasSystemPrompt: boolean;
}

/**
 * Drive with agents from the multi-drive API
 */
export interface DriveWithAgents {
  driveId: string;
  driveName: string;
  driveSlug: string;
  agentCount: number;
  agents: AgentSummary[];
}

/**
 * Response from /api/agents/multi-drive
 */
interface AgentsResponse {
  success: boolean;
  totalCount: number;
  driveCount: number;
  summary: string;
  agentsByDrive: DriveWithAgents[];
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch agents: ${response.status}`);
  }
  return response.json();
};

/**
 * Hook for fetching all accessible AI agents across drives
 *
 * @param driveId - Optional drive ID to filter agents to a single drive
 * @param options.includeSystemPrompt - Include full system prompts (default: false)
 * @param options.refreshInterval - Refresh interval in ms (default: 60000 = 1 minute)
 */
export function usePageAgents(
  driveId?: string,
  options: {
    includeSystemPrompt?: boolean;
    refreshInterval?: number;
  } = {}
) {
  const { includeSystemPrompt = false, refreshInterval = 60000 } = options;
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  // Build the API URL with query params
  const swrKey = useMemo(() => {
    const params = new URLSearchParams();
    params.set('groupByDrive', 'true');
    if (includeSystemPrompt) {
      params.set('includeSystemPrompt', 'true');
    }
    return `/api/agents/multi-drive?${params.toString()}`;
  }, [includeSystemPrompt]);

  const { data, error, mutate, isLoading } = useSWR<AgentsResponse>(
    swrKey,
    fetcher,
    {
      isPaused: () => isAnyActive,
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  // Filter by drive if driveId is provided
  const agentsByDrive = useMemo(() => {
    if (!data?.agentsByDrive) return [];
    if (!driveId) return data.agentsByDrive;
    return data.agentsByDrive.filter(d => d.driveId === driveId);
  }, [data, driveId]);

  // Flatten all agents for convenience
  const allAgents = useMemo(() => {
    return agentsByDrive.flatMap(d => d.agents);
  }, [agentsByDrive]);

  // Convert AgentSummary to AgentInfo for use with agent selection
  const toAgentInfo = (agent: AgentSummary): AgentInfo => ({
    id: agent.id,
    title: agent.title || 'Unnamed Agent',
    driveId: agent.driveId,
    driveName: agent.driveName,
    systemPrompt: agent.systemPrompt,
    aiProvider: agent.aiProvider,
    aiModel: agent.aiModel,
    enabledTools: agent.enabledTools,
  });

  return {
    agentsByDrive,
    allAgents,
    totalCount: data?.totalCount ?? 0,
    driveCount: data?.driveCount ?? 0,
    isLoading: isLoading && !data,
    isError: !!error,
    error,
    mutate,
    toAgentInfo,
  };
}

