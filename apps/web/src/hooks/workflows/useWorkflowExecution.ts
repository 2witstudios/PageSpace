'use client';

import useSWR from 'swr';

interface WorkflowExecutionStep {
  id: string;
  workflowExecutionId: string;
  workflowStepId: string | null;
  stepOrder: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  agentInput: Record<string, unknown> | null;
  agentOutput: Record<string, unknown> | null;
  userInput: Record<string, unknown> | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowExecutionState {
  execution: {
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
  };
  steps: WorkflowExecutionStep[];
  template: {
    id: string;
    name: string;
    description: string | null;
  };
}

interface UseWorkflowExecutionResult {
  execution: WorkflowExecutionState | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
  refresh: () => void;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch workflow execution');
  }
  return res.json();
};

export function useWorkflowExecution(
  executionId: string | null
): UseWorkflowExecutionResult {
  const { data, error, isLoading, mutate } = useSWR<WorkflowExecutionState>(
    executionId ? `/api/workflows/executions/${executionId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 2000, // Refresh every 2s while execution is active
    }
  );

  return {
    execution: data ?? null,
    isLoading,
    isError: !!error,
    error,
    refresh: mutate,
  };
}
