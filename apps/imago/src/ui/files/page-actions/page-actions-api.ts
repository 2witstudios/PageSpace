// The writes the page "…" menu and the multi-select toolbar make, through imago's API client
// (the session cookie, the CSRF token). Each one is the route apps/web already answers.

import type { ApiClient } from '@/api/client';
import type { ExportFormat } from './page-actions-model';

const segment = encodeURIComponent;

export const pageActionPaths = {
  /** GET lists the viewer's favorites; POST favorites a page or drive. */
  favorites: '/api/user/favorites',
  /** DELETE removes one favorite by its own row id. */
  favorite: (favoriteId: string) => `/api/user/favorites/${segment(favoriteId)}`,
  page: (pageId: string) => `/api/pages/${segment(pageId)}`,
  drive: (driveId: string) => `/api/drives/${segment(driveId)}`,
  exportPage: (pageId: string, format: ExportFormat) => `/api/pages/${segment(pageId)}/export/${format}`,
  /** Moves pages, and by default their children, to the trash. */
  bulkDelete: '/api/pages/bulk-delete',
};

/** The favorite row id of a page, from GET /api/user/favorites; undefined when it is not favorited. */
export const favoriteIdOf = (body: unknown, pageId: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { favorites } = body as { readonly favorites?: unknown };
  if (!Array.isArray(favorites)) return undefined;
  for (const item of favorites as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, itemType, page } = item as { readonly id?: unknown; readonly itemType?: unknown; readonly page?: unknown };
    const pageRef = typeof page === 'object' && page !== null ? (page as { readonly id?: unknown }).id : undefined;
    if (itemType === 'page' && pageRef === pageId && typeof id === 'string') return id;
  }
  return undefined;
};

export const addFavorite = (client: ApiClient, pageId: string): Promise<unknown> =>
  client.apiFetch(pageActionPaths.favorites, { method: 'POST', json: { itemType: 'page', itemId: pageId } });

/** Looks the favorite row up on the server first: a stale cache must not make this a no-op. */
export const removeFavorite = async (client: ApiClient, pageId: string): Promise<void> => {
  const favoriteId = favoriteIdOf(await client.apiFetch(pageActionPaths.favorites), pageId);
  if (favoriteId === undefined) return;
  await client.apiFetch(pageActionPaths.favorite(favoriteId), { method: 'DELETE' });
};

export const setPageProtected = (client: ApiClient, pageId: string, isPrivate: boolean): Promise<unknown> =>
  client.apiFetch(pageActionPaths.page(pageId), { method: 'PATCH', json: { isPrivate } });

/** Sets (or, with null, clears) the drive's home page. */
export const setHomePage = (client: ApiClient, driveId: string, homePageId: string | null): Promise<unknown> =>
  client.apiFetch(pageActionPaths.drive(driveId), { method: 'PATCH', json: { homePageId } });

export const bulkTrash = (client: ApiClient, pageIds: readonly string[]): Promise<unknown> =>
  client.apiFetch(pageActionPaths.bulkDelete, { method: 'DELETE', json: { pageIds, trashChildren: true } });

/** Downloads a page export the way apps/web's ExportDropdown does: the bytes, then a named file. */
export const downloadExport = async (
  client: ApiClient,
  pageId: string,
  format: ExportFormat,
  filename: string,
): Promise<void> => {
  const response = await client.apiStream(pageActionPaths.exportPage(pageId, format));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(url);
  link.remove();
};
