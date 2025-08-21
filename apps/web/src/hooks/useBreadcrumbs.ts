import useSWR from 'swr';
import { pages } from '@pagespace/db';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function useBreadcrumbs(pageId: string | null) {
  const { data, error } = useSWR<(typeof pages.$inferSelect & { drive: { slug: string } | null })[]>(
    pageId ? `/api/pages/${pageId}/breadcrumbs` : null,
    fetcher
  );

  return {
    breadcrumbs: data,
    isLoading: !error && !data,
    isError: error,
  };
}