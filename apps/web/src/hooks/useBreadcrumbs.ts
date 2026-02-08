import { useRef, useEffect } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

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
  const swrKey = pageId ? `/api/pages/${pageId}/breadcrumbs` : null;
  const { data, error, mutate, isValidating } = useSWR<BreadcrumbItem[]>(
    swrKey,
    fetcher,
    {
      revalidateOnFocus: false,
      errorRetryCount: 3,
      errorRetryInterval: 2000,
    }
  );
  const { cache } = useSWRConfig();

  // Self-healing: detect when SWR gets stuck (valid key, no data, no error, not fetching).
  // Same fix as usePageTree — clears SWR cache and re-triggers fetch.
  const stuckRetryCount = useRef(0);

  useEffect(() => {
    stuckRetryCount.current = 0;
  }, [swrKey]);

  useEffect(() => {
    if (!swrKey || data || error || isValidating) return;
    if (stuckRetryCount.current >= 2) return;

    const timeoutId = setTimeout(() => {
      stuckRetryCount.current += 1;
      console.log(`[useBreadcrumbs] SWR appears stuck — auto-retrying (${stuckRetryCount.current}/2)`);
      cache.delete(swrKey);
      mutate();
    }, 3000);

    return () => clearTimeout(timeoutId);
  }, [swrKey, data, error, isValidating, cache, mutate]);

  return {
    breadcrumbs: data,
    // Not loading if we have data, have an error, or don't even have a pageId to fetch
    isLoading: !error && !data && !!pageId,
    isError: error,
  };
}
