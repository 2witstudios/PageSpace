import useSWR from 'swr';
import { pages } from '@pagespace/db';
import { fetchWithAuth } from '@/lib/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function useBreadcrumbs(pageId: string | null) {
  const { data, error } = useSWR<(typeof pages.$inferSelect & { drive: { id: string; slug: string; name: string } | null })[]>(
    pageId ? `/api/pages/${pageId}/breadcrumbs` : null,
    fetcher
  );

  return {
    breadcrumbs: data,
    isLoading: !error && !data,
    isError: error,
  };
}