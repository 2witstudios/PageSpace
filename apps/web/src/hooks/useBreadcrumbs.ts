import { useRef } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isEditingActive } from '@/stores/useEditingStore';

interface BreadcrumbItem {
  id: string;
  title: string;
  type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS' | 'FILE' | 'SHEET';
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

  const { data, error, isLoading } = useSWR<BreadcrumbItem[]>(
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
    isLoading,
    isError: error,
  };
}
