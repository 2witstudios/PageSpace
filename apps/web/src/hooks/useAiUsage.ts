import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';
import { useEditingStore } from '@/stores/useEditingStore';

/**
 * AI Usage data structure - separates billing from context metrics
 */
export interface AiUsageData {
  // Billing metrics (cumulative)
  billing: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };

  // Context metrics (current state)
  context: {
    currentSize: number;
    messagesInContext: number;
    windowSize: number;
    usagePercent: number;
    wasTruncated: boolean;
  };

  model: string;
  provider: string;
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
    billing: {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      totalCost: number;
    };
    context: {
      currentContextSize: number;
      messagesInContext: number;
      contextWindowSize: number;
      contextUsagePercent: number;
      wasTruncated: boolean;
    } | null;
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
    ? `/api/ai/global/${encodeURIComponent(conversationId)}/usage`
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

  // Map API response to usage data structure
  const usageData: AiUsageData | null = data?.summary ? {
    billing: {
      inputTokens: data.summary.billing.totalInputTokens,
      outputTokens: data.summary.billing.totalOutputTokens,
      totalTokens: data.summary.billing.totalTokens,
      cost: data.summary.billing.totalCost,
    },
    context: data.summary.context ? {
      currentSize: data.summary.context.currentContextSize,
      messagesInContext: data.summary.context.messagesInContext,
      windowSize: data.summary.context.contextWindowSize,
      usagePercent: data.summary.context.contextUsagePercent,
      wasTruncated: data.summary.context.wasTruncated,
    } : {
      // Legacy fallback for old data without context tracking
      currentSize: data.summary.billing.totalInputTokens,
      messagesInContext: 0,
      windowSize: data.summary.mostRecentModel
        ? getContextWindow(data.summary.mostRecentModel)
        : 200000,
      usagePercent: data.summary.mostRecentModel
        ? Math.round((data.summary.billing.totalInputTokens / getContextWindow(data.summary.mostRecentModel)) * 100)
        : 0,
      wasTruncated: false,
    },
    model: data.summary.mostRecentModel || 'unknown',
    provider: data.summary.mostRecentProvider || 'unknown',
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

  // Map API response to usage data structure
  const usageData: AiUsageData | null = data?.summary ? {
    billing: {
      inputTokens: data.summary.billing.totalInputTokens,
      outputTokens: data.summary.billing.totalOutputTokens,
      totalTokens: data.summary.billing.totalTokens,
      cost: data.summary.billing.totalCost,
    },
    context: data.summary.context ? {
      currentSize: data.summary.context.currentContextSize,
      messagesInContext: data.summary.context.messagesInContext,
      windowSize: data.summary.context.contextWindowSize,
      usagePercent: data.summary.context.contextUsagePercent,
      wasTruncated: data.summary.context.wasTruncated,
    } : {
      // Legacy fallback for old data without context tracking
      currentSize: data.summary.billing.totalInputTokens,
      messagesInContext: 0,
      windowSize: data.summary.mostRecentModel
        ? getContextWindow(data.summary.mostRecentModel)
        : 200000,
      usagePercent: data.summary.mostRecentModel
        ? Math.round((data.summary.billing.totalInputTokens / getContextWindow(data.summary.mostRecentModel)) * 100)
        : 0,
      wasTruncated: false,
    },
    model: data.summary.mostRecentModel || 'unknown',
    provider: data.summary.mostRecentProvider || 'unknown',
  } : null;

  return {
    usage: usageData,
    logs: data?.logs || [],
    isLoading: !error && !data && swrKey !== null,
    isError: error,
    mutate,
  };
}
