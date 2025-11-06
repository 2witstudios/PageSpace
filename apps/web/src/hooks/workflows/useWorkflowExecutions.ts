'use client';

import useSWR from 'swr';

interface WorkflowExecution {
  id: string;
  workflowTemplateId: string;
  userId: string;
  driveId: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentStepOrder: number | null;
  accumulatedContext: Record<string, unknown>;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ExecutionFilters {
  driveId?: string;
  status?: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  limit?: number;
}

interface UseWorkflowExecutionsResult {
  executions: WorkflowExecution[];
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
  refresh: () => void;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch workflow executions');
  }
  const data = await res.json();
  return data.executions;
};

export function useWorkflowExecutions(
  filters?: ExecutionFilters
): UseWorkflowExecutionsResult {
  const queryParams = new URLSearchParams();

  if (filters?.driveId) {
    queryParams.append('driveId', filters.driveId);
  }

  if (filters?.status) {
    queryParams.append('status', filters.status);
  }

  if (filters?.limit) {
    queryParams.append('limit', filters.limit.toString());
  }

  const queryString = queryParams.toString();
  const url = `/api/workflows/executions${queryString ? `?${queryString}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<WorkflowExecution[]>(
    url,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 5000, // Refresh every 5s for running executions
    }
  );

  return {
    executions: data ?? [],
    isLoading,
    isError: !!error,
    error,
    refresh: mutate,
  };
}
