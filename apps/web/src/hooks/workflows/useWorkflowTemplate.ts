'use client';

import useSWR from 'swr';

interface WorkflowStep {
  id: string;
  workflowTemplateId: string;
  stepOrder: number;
  agentId: string;
  promptTemplate: string;
  requiresUserInput: boolean;
  inputSchema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowTemplateWithSteps {
  id: string;
  name: string;
  description: string | null;
  driveId: string;
  createdBy: string;
  category: string | null;
  tags: string[] | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  steps: WorkflowStep[];
}

interface UseWorkflowTemplateResult {
  template: WorkflowTemplateWithSteps | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
  refresh: () => void;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch workflow template');
  }
  return res.json();
};

export function useWorkflowTemplate(
  templateId: string | null
): UseWorkflowTemplateResult {
  const { data, error, isLoading, mutate } = useSWR<WorkflowTemplateWithSteps>(
    templateId ? `/api/workflows/templates/${templateId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 0,
    }
  );

  return {
    template: data ?? null,
    isLoading,
    isError: !!error,
    error,
    refresh: mutate,
  };
}
