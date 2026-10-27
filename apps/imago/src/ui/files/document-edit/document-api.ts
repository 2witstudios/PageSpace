// The page routes a document edit uses, called through imago's API client:
// the session cookie on every request and the CSRF token on every write.
// Saves go to apps/web's existing PATCH /api/pages/[pageId] (the route
// classic's DocumentView saves through), carrying the revision the editor
// last knew so the server answers 409 when someone else saved first, and this
// tab's socket id so realtime does not echo the save back as someone else's.

import useSWR from 'swr';
import type { ApiClient } from '@/api/client';
import { ApiError, INVALID_RESPONSE } from '@/api/errors';
import { useApiClient } from '@/api/swr-provider';
import { pageKey } from '../page-object/page-object';
import type { DocumentPatch } from './document-saver';

/** What the viewer may do on a page (apps/web's permissions check route). */
export const permissionsPath = (pageId: string): string =>
  `/api/pages/${encodeURIComponent(pageId)}/permissions/check`;

/** The header apps/web copies into its page events as `socketId`. */
export const SOCKET_ID_HEADER = 'X-Socket-ID';

/** The stored copy of a document, as GET or PATCH /api/pages/[pageId] answers. */
export type StoredDocument = {
  readonly revision: number;
  readonly title: string;
  readonly content: string;
};

const invalid = (status: number): ApiError =>
  new ApiError({ status, code: INVALID_RESPONSE, message: 'The page answer carried no revision' });

/** The stored copy from a page answer; throws when it has no revision to save against. */
export const storedDocumentOf = (body: unknown): StoredDocument => {
  const { revision, title, content } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof revision !== 'number') throw invalid(200);
  return {
    revision,
    title: typeof title === 'string' ? title : '',
    content: typeof content === 'string' ? content : '',
  };
};

/** Saves a change to a page against the revision the editor last knew. */
export const saveDocument = async (
  client: ApiClient,
  pageId: string,
  patch: DocumentPatch,
  expectedRevision: number,
  socketId: string | undefined,
): Promise<StoredDocument> =>
  storedDocumentOf(
    await client.apiFetch<unknown>(pageKey(pageId), {
      method: 'PATCH',
      json: { ...patch, expectedRevision },
      headers: socketId === undefined ? undefined : { [SOCKET_ID_HEADER]: socketId },
    }),
  );

/** The page as it is stored now, asked for afresh (not from SWR's cache). */
export const fetchStoredDocument = async (client: ApiClient, pageId: string): Promise<StoredDocument> =>
  storedDocumentOf(await client.apiFetch<unknown>(pageKey(pageId)));

/**
 * Whether the server lets the viewer edit the page. Only a definite yes
 * makes the editor editable: while it is asked, or when it cannot be, the
 * document stays read-only.
 */
export const useCanEdit = (pageId: string): boolean => {
  const client = useApiClient();
  const { data } = useSWR(['imago:document-edit-rights', pageId] as const, async ([, id]) => {
    const rights = await client.apiFetch<unknown>(permissionsPath(id));
    return typeof rights === 'object' && rights !== null && (rights as { canEdit?: unknown }).canEdit === true;
  });
  return data === true;
};
