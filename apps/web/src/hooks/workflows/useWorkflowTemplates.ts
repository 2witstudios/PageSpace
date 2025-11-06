'use client';

import useSWR from 'swr';

interface WorkflowTemplate {
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
  stepCount: number;
}

interface WorkflowFilters {
  driveId?: string;
  category?: string;
  tags?: string[];
}

interface UseWorkflowTemplatesResult {
  templates: WorkflowTemplate[];
  isLoading: boolean;
  isError: boolean;
  error: Error | undefined;
  refresh: () => void;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch workflow templates');
  }
  const data = await res.json();
  return data.templates;
};

export function useWorkflowTemplates(
  filters?: WorkflowFilters
): UseWorkflowTemplatesResult {
  const queryParams = new URLSearchParams();

  if (filters?.driveId) {
    queryParams.append('driveId', filters.driveId);
  }

  if (filters?.category) {
    queryParams.append('category', filters.category);
  }

  if (filters?.tags && filters.tags.length > 0) {
    queryParams.append('tags', filters.tags.join(','));
  }

  const queryString = queryParams.toString();
  const url = `/api/workflows/templates${queryString ? `?${queryString}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<WorkflowTemplate[]>(
    url,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 0,
    }
  );

  return {
    templates: data ?? [],
    isLoading,
    isError: !!error,
    error,
    refresh: mutate,
  };
}
