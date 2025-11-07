import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';
import { useEditingStore } from '@/stores/useEditingStore';

/**
 * AI Usage data structure
 */
export interface AiUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  model: string;
  provider: string;
  contextWindowSize: number;
  contextUsagePercent: number;
}

interface AiUsageLog {
  id: string;
  timestamp: Date;
  userId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  conversationId: string | null;
  messageId: string | null;
  pageId: string | null;
  driveId: string | null;
  success: boolean;
  error: string | null;
}

interface AiUsageResponse {
  logs: AiUsageLog[];
  summary: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCost: number;
    mostRecentModel: string | null;
    mostRecentProvider: string | null;
  };
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

/**
 * Hook for fetching AI usage data for a specific conversation
 *
 * @param conversationId - The conversation ID to fetch usage for
 * @param refreshInterval - Optional refresh interval in milliseconds (default: 15000ms)
 */
export function useAiUsage(conversationId: string | null | undefined, refreshInterval = 15000) {
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  const swrKey = conversationId
    ? `/api/ai_conversations/${encodeURIComponent(conversationId)}/usage`
    : null;

  const { data, error, mutate } = useSWR<AiUsageResponse>(
    swrKey,
    fetcher,
    {
      isPaused: () => isAnyActive,
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 2000,
    }
  );

  // Calculate aggregated usage data
  const usageData: AiUsageData | null = data?.summary ? {
    inputTokens: data.summary.totalInputTokens,
    outputTokens: data.summary.totalOutputTokens,
    totalTokens: data.summary.totalTokens,
    cost: data.summary.totalCost,
    model: data.summary.mostRecentModel || 'unknown',
    provider: data.summary.mostRecentProvider || 'unknown',
    contextWindowSize: data.summary.mostRecentModel
      ? getContextWindow(data.summary.mostRecentModel)
      : 128000,
    contextUsagePercent: data.summary.mostRecentModel
      ? Math.round((data.summary.totalTokens / getContextWindow(data.summary.mostRecentModel)) * 100)
      : 0,
  } : null;

  return {
    usage: usageData,
    logs: data?.logs || [],
    isLoading: !error && !data && swrKey !== null,
    isError: error,
    mutate,
  };
}

/**
 * Hook for fetching AI usage data for a specific page (across all conversations)
 */
export function usePageAiUsage(pageId: string | null | undefined, refreshInterval = 15000) {
  const isAnyActive = useEditingStore(state => state.isAnyActive());

  const swrKey = pageId
    ? `/api/pages/${encodeURIComponent(pageId)}/ai-usage`
    : null;

  const { data, error, mutate } = useSWR<AiUsageResponse>(
    swrKey,
    fetcher,
    {
      isPaused: () => isAnyActive,
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 2000,
    }
  );

  // Calculate aggregated usage data
  const usageData: AiUsageData | null = data?.summary ? {
    inputTokens: data.summary.totalInputTokens,
    outputTokens: data.summary.totalOutputTokens,
    totalTokens: data.summary.totalTokens,
    cost: data.summary.totalCost,
    model: data.summary.mostRecentModel || 'unknown',
    provider: data.summary.mostRecentProvider || 'unknown',
    contextWindowSize: data.summary.mostRecentModel
      ? getContextWindow(data.summary.mostRecentModel)
      : 128000,
    contextUsagePercent: data.summary.mostRecentModel
      ? Math.round((data.summary.totalTokens / getContextWindow(data.summary.mostRecentModel)) * 100)
      : 0,
  } : null;

  return {
    usage: usageData,
    logs: data?.logs || [],
    isLoading: !error && !data && swrKey !== null,
    isError: error,
    mutate,
  };
}
