'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePage } from '@/ui/files/page-object/page-object';
import { renderLoadingState, renderErrorState, edgeOf } from '@/ui/frame/edge-state/edge-state.render';
import { PAGE_NOT_FOUND, renderNotFound } from '@/ui/frame/not-found/not-found.render';

/** Resolve citations through the permission-filtered API, never the current drive. */
export function PageResolver({ pageId }: { pageId: string }) {
  const router = useRouter();
  const { data, error, mutate } = usePage(pageId);
  const page = data && typeof data === 'object' ? data as { driveId?: unknown; isTrashed?: unknown } : null;
  const driveId = typeof page?.driveId === 'string' && page.isTrashed !== true ? page.driveId : null;
  useEffect(() => {
    if (driveId) router.replace(`/${encodeURIComponent(driveId)}/files/${encodeURIComponent(pageId)}`);
  }, [driveId, pageId, router]);
  if (error && edgeOf(error) === 'error') return renderErrorState({ title: 'Could not open this page', retry: () => void mutate() });
  if (error || (data !== undefined && driveId === null)) return renderNotFound({ ...PAGE_NOT_FOUND, homeHref: '/', linkLabel: 'Back to Chat' });
  return renderLoadingState('Opening page…');
}
