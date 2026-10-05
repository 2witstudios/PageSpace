'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';
import { edgeOf, renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { PAGE_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';

export type PageObjectProps = {
  /** The drive the address names. */
  readonly driveId: string;
  readonly pageId: string;
  /** The page's object view, drawn once the page is known to be this drive's. */
  readonly children: ReactNode;
};

/** What the address's page is to the viewer, from GET /api/pages/[pageId]. */
export type PageEdge = 'loading' | 'ready' | 'not-found' | 'error';

/**
 * A page is this address's object only when apps/web lets the viewer read it,
 * it lives in the drive the address names and it is not in the trash. A 404,
 * a 403 and a page of another drive answer the same, so the object never
 * says which.
 */
export const pageEdgeOf = (data: unknown, error: unknown, driveId: string): PageEdge => {
  if (data === undefined) {
    if (error === undefined) return 'loading';
    return edgeOf(error);
  }
  if (typeof data !== 'object' || data === null) return 'not-found';
  const { driveId: owner, isTrashed } = data as { driveId?: unknown; isTrashed?: unknown };
  return owner === driveId && isTrashed !== true ? 'ready' : 'not-found';
};

/**
 * The Files section's object slot: it settles what the page id names before
 * the page's own view draws, so an unknown id draws not-found and a failed
 * request a way to ask again.
 */
export function PageObject({ driveId, pageId, children }: PageObjectProps) {
  const { data, error, mutate } = useSWR<unknown>(`/api/pages/${encodeURIComponent(pageId)}`);
  const edge = pageEdgeOf(data, error, driveId);
  if (edge === 'loading') return renderLoadingState('Loading page…');
  if (edge === 'not-found') {
    return renderNotFound({
      ...PAGE_NOT_FOUND,
      homeHref: `/${encodeURIComponent(driveId)}/files`,
      linkLabel: 'Back to Files',
    });
  }
  if (edge === 'error') return renderErrorState({ title: 'Could not load this page', retry: () => void mutate() });
  return children;
}
