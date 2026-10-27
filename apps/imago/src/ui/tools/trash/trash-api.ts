// The trash routes apps/web already has, called through imago's API client:
// the session cookie on every request, the CSRF token on every write.

import type { ApiClient } from '@/api/client';
import type { TrashPage } from './trash-model';

const segment = encodeURIComponent;

export const trashPaths = {
  /** A drive's trashed pages as a tree; owners and admins only (403 for anyone else). */
  trash: (driveId: string) => `/api/drives/${segment(driveId)}/trash`,
  /** Every live page of a drive, flat: used to name the folder a page was in. */
  drivePages: (driveId: string) => `/api/drives/${segment(driveId)}/pages?ls=true&recursive=true`,
  /** Puts a trashed page, and what was inside it, back where it was. */
  restore: (pageId: string) => `/api/pages/${segment(pageId)}/restore`,
  /** Deletes a trashed page for good. */
  deleteForever: (pageId: string) => `/api/trash/${segment(pageId)}`,
};

export const fetchTrash = (client: ApiClient, driveId: string): Promise<readonly TrashPage[]> =>
  client.apiFetch<readonly TrashPage[]>(trashPaths.trash(driveId));

/** Page id to title for the drive's live pages. */
export const fetchDrivePageTitles = async (client: ApiClient, driveId: string): Promise<Map<string, string>> => {
  const body = await client.apiFetch<{ readonly pages: readonly { readonly id: string; readonly title: string }[] }>(
    trashPaths.drivePages(driveId),
  );
  return new Map(body.pages.map((page) => [page.id, page.title]));
};

export const restorePage = (client: ApiClient, pageId: string) =>
  client.apiFetch(trashPaths.restore(pageId), { method: 'POST' });

export const deleteTrashedPage = (client: ApiClient, pageId: string) =>
  client.apiFetch(trashPaths.deleteForever(pageId), { method: 'DELETE' });
