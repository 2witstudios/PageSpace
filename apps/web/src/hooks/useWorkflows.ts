import { useRef, useCallback } from 'react';
import useSWR from 'swr';
import { isEditingActive } from '@/stores/useEditingStore';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import type { Workflow } from '@/components/workflows/types';

const fetcher = (url: string) => fetchWithAuth(url).then(res => {
  if (!res.ok) throw new Error('Failed to fetch workflows');
  return res.json();
});

export function useWorkflows(driveId: string) {
  const hasLoadedRef = useRef(false);

  const { data, error, isLoading, mutate } = useSWR<Workflow[]>(
    driveId ? `/api/workflows?driveId=${driveId}` : null,
    fetcher,
    {
      isPaused: () => hasLoadedRef.current && isEditingActive(),
      onSuccess: () => { hasLoadedRef.current = true; },
      refreshInterval: 300000,
      revalidateOnFocus: false,
    }
  );

  const runWorkflow = useCallback(async (workflowId: string) => {
    const result = await post<{ success: boolean; error?: string; responseText?: string; toolCallCount?: number; durationMs?: number }>(
      `/api/workflows/${workflowId}/run`
    );
    mutate();
    return result;
  }, [mutate]);

  const toggleWorkflow = useCallback(async (workflowId: string, isEnabled: boolean) => {
    const result = await patch(`/api/workflows/${workflowId}`, { isEnabled });
    mutate();
    return result;
  }, [mutate]);

  const deleteWorkflow = useCallback(async (workflowId: string) => {
    await del(`/api/workflows/${workflowId}`);
    mutate();
  }, [mutate]);

  return {
    workflows: data ?? [],
    isLoading,
    error,
    mutate,
    runWorkflow,
    toggleWorkflow,
    deleteWorkflow,
  };
}
