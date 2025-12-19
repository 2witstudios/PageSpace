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
  const { data, error } = useSWR<BreadcrumbItem[]>(
    pageId ? `/api/pages/${pageId}/breadcrumbs` : null,
    fetcher,
    {
      isPaused: isEditingActive,
    }
  );

  return {
    breadcrumbs: data,
    isLoading: !error && !data,
    isError: error,
  };
}
