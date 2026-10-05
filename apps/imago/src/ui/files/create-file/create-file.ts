'use client';

// + in the tree pane: a new document in the selected folder, shown at once.
//
// The page is created by apps/web's POST /api/pages (classic's quick create
// request: title, type, driveId, parentId) through imago's client, so the
// session cookie and CSRF token ride along. Its row shows the moment + is
// pressed; the answer names it with the server's id and opens it, and the
// drive tree (revalidated here, and by the page:created event realtime sends)
// then draws it alone. A refused or failed create removes the row and says
// why.

import { useCallback, useRef } from 'react';
import { getPageTypeConfig, PageType } from '@pagespace/lib/client-safe';
import type { ApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';
import { useApiClient } from '@/api/swr-provider';
import { dispatch, transactions } from '../../store/transactions';
import type { FileNode, PageResponse } from '../file-model/file-node';
import { childIdsOf, createParentFor } from '../tree-view/tree-view';

/** apps/web's page create route (apps/web/src/app/api/pages/route.ts). */
export const CREATE_PAGE_PATH = '/api/pages';

/** A new document's title, as classic's quick create names one. */
export const NEW_DOCUMENT_TITLE = `Untitled ${getPageTypeConfig(PageType.DOCUMENT).displayName}`;

const CREATE_FAILED = 'Could not create the page.';

const OFFLINE = 'Could not reach PageSpace.';

/** Creates an empty document in a drive, under `parentId` (null: the top). */
export const createDocument = (
  client: ApiClient,
  { driveId, parentId }: { readonly driveId: string; readonly parentId: string | null },
): Promise<PageResponse> =>
  client.apiFetch<PageResponse>(CREATE_PAGE_PATH, {
    method: 'POST',
    json: { title: NEW_DOCUMENT_TITLE, type: PageType.DOCUMENT, driveId, parentId },
  });

/** A page's address in the files section; Link and the router add imago's basePath. */
export const fileHref = (driveId: string, pageId: string): string =>
  `/${encodeURIComponent(driveId)}/files/${encodeURIComponent(pageId)}`;

export type CreateFileOptions = {
  readonly driveId: string;
  /** The tree as the pane draws it, to find the selected folder. */
  readonly nodes: readonly FileNode[];
  readonly selectedId: string | null;
  /** Refetches the drive's tree. */
  readonly revalidate: () => void;
  /** Opens a page: a client navigation. */
  readonly open: (href: string) => void;
};

/** A fresh key per create: several can start in one millisecond. */
const mintKey = (): string => `new-${crypto.randomUUID()}`;

/**
 * The + action: creates a document where the selection says, and opens it.
 * One create at a time: a press while one is in flight does nothing. The
 * filter clears, so the new row shows wherever it lands.
 */
export const useCreateFile = ({ driveId, nodes, selectedId, revalidate, open }: CreateFileOptions) => {
  const client = useApiClient();
  const creating = useRef(false);
  return useCallback(async (): Promise<void> => {
    if (creating.current) return;
    creating.current = true;
    const parentId = createParentFor(nodes, selectedId);
    const key = mintKey();
    dispatch(transactions.beginFileCreate, {
      key,
      driveId,
      parentId,
      title: NEW_DOCUMENT_TITLE,
      pageId: null,
      knownIds: childIdsOf(nodes, parentId),
    });
    dispatch(transactions.setFileFilter, '');
    if (parentId !== null) dispatch(transactions.expandFileFolder, parentId);
    try {
      const page = await createDocument(client, { driveId, parentId });
      dispatch(transactions.fileCreated, { key, pageId: page.id });
      revalidate();
      open(fileHref(driveId, page.id));
    } catch (error) {
      dispatch(transactions.fileCreateFailed, {
        key,
        error: error instanceof ApiError ? `${CREATE_FAILED} ${error.message}` : `${CREATE_FAILED} ${OFFLINE}`,
      });
    } finally {
      creating.current = false;
    }
  }, [client, driveId, nodes, selectedId, revalidate, open]);
};
