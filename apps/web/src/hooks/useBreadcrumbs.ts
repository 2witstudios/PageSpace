import { useRef, useEffect } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isEditingActive } from '@/stores/useEditingStore';

interface BreadcrumbItem {
  id: string;
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET' | 'TASK_LIST';
  parentId: string | null;
  driveId: string;
  drive: { id: string; slug: string; name: string } | null;
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function useBreadcrumbs(pageId: string | null) {
  // Track if initial data has been loaded to avoid blocking first fetch
  const hasLoadedRef = useRef(false);

  // Reset loaded status when pageId changes to ensure fresh pages can load even during editing
  useEffect(() => {
    hasLoadedRef.current = false;
  }, [pageId]);

  const { data, error } = useSWR<BreadcrumbItem[]>(
    pageId ? `/api/pages/${pageId}/breadcrumbs` : null,
    fetcher,
    {
      // Only pause revalidation after initial load - never block the first fetch
      isPaused: () => hasLoadedRef.current && isEditingActive(),
      onSuccess: () => {
        hasLoadedRef.current = true;
      },
    }
  );

  return {
    breadcrumbs: data,
    // Not loading if we have data, have an error, or don't even have a pageId to fetch
    isLoading: !error && !data && !!pageId,
    isError: error,
  };
}
