'use client';

import useSWR from 'swr';
import { isPageTypeValue, type PageTypeValue } from '@pagespace/lib/utils/enums';

/** apps/web's favorites: pages and drives across every drive, in the user's order. */
export const FAVORITES = '/api/user/favorites';

export type FavoritePage = { readonly id: string; readonly title: string; readonly type: PageTypeValue };

/** This drive's favorite pages from GET /api/user/favorites. */
export const favoritesOf = (body: unknown, driveId: string): readonly FavoritePage[] => {
  if (typeof body !== 'object' || body === null) return [];
  const { favorites } = body as { readonly favorites?: unknown };
  if (!Array.isArray(favorites)) return [];
  return favorites.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { itemType, page } = item as { readonly itemType?: unknown; readonly page?: unknown };
    if (itemType !== 'page' || typeof page !== 'object' || page === null) return [];
    const { id, title, type, driveId: owner } = page as Record<string, unknown>;
    return typeof id === 'string' && typeof title === 'string' && typeof type === 'string' && isPageTypeValue(type) && owner === driveId
      ? [{ id, title, type }]
      : [];
  });
};

/** This drive's favorite pages, live with the API. */
export const useFavorites = (driveId: string): readonly FavoritePage[] => {
  const { data } = useSWR<unknown>(FAVORITES);
  return favoritesOf(data, driveId);
};
