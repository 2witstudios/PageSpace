'use client';

import type { ReactNode } from 'react';
import { renderObjectPlaceholder } from '../../frame/shell/object-placeholder';
import { DocumentView, type DocumentPage } from '../document-view/document-view';
import { usePage } from '../page-object/page-object';

export type PageViewProps = {
  readonly driveId: string;
  readonly pageId: string;
};

/** The page as a document the view can draw, or null for any other page type. */
export const documentOf = (data: unknown): DocumentPage | null => {
  if (typeof data !== 'object' || data === null) return null;
  const { id, title, type, content, revision, contentMode } = data as Record<string, unknown>;
  if (type !== 'DOCUMENT' || typeof id !== 'string') return null;
  return {
    id,
    title: typeof title === 'string' ? title : '',
    content: typeof content === 'string' ? content : '',
    revision: typeof revision === 'number' ? revision : 0,
    contentMode: contentMode === 'markdown' ? 'markdown' : 'html',
  };
};

/**
 * The page's own view inside the Files object slot, once PageObject has
 * settled that it is this drive's: a document reads in place; other page
 * types keep the placeholder until their leaves land. It reads the same SWR
 * entry PageObject loaded, so it asks the server nothing more.
 */
export function PageView({ driveId, pageId }: PageViewProps): ReactNode {
  const { data } = usePage(pageId);
  const page = documentOf(data);
  if (page === null) return renderObjectPlaceholder('Page');
  return <DocumentView key={page.id} driveId={driveId} page={page} />;
}
