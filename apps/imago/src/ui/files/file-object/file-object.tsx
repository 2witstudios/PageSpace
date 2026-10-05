'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';
import { PageType } from '@pagespace/lib/client-safe';
import { FolderView } from '../folder-view/folder-view';

export type FileObjectProps = {
  readonly driveId: string;
  readonly pageId: string;
  /** The view any page other than a folder opens in. */
  readonly children: ReactNode;
};

/** Whether GET /api/pages/[pageId] answered a folder. */
const isFolderPage = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === PageType.FOLDER;

/**
 * What a page of the Files section opens as: a folder in the Finder-style
 * folder browser, anything else in its own view. It sits behind PageObject's
 * gate and reads the gate's answer from SWR's cache (the same key), so the
 * page is asked for once.
 */
export function FileObject({ driveId, pageId, children }: FileObjectProps): ReactNode {
  const { data } = useSWR<unknown>(`/api/pages/${encodeURIComponent(pageId)}`);
  return isFolderPage(data) ? <FolderView driveId={driveId} folderId={pageId} /> : children;
}
