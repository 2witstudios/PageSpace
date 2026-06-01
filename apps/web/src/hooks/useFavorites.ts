import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { post, del, fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { FavoriteItem } from '@/app/api/user/favorites/route';

interface FavoritesState {
  // Raw favorites data from API
  favorites: FavoriteItem[];
  // Set of page IDs for quick lookup (backward compatibility)
  pageIds: Set<string>;
  // Set of drive IDs for quick lookup
  driveIds: Set<string>;
  // Loading states
  isLoading: boolean;
  isSynced: boolean;
  // Actions
  fetchFavorites: () => Promise<void>;
  addFavorite: (id: string, itemType?: 'page' | 'drive') => Promise<void>;
  removeFavorite: (id: string, itemType?: 'page' | 'drive') => Promise<void>;
  removeFavoriteById: (favoriteId: string) => Promise<void>;
  isFavorite: (id: string, itemType?: 'page' | 'drive') => boolean;
  getFavoriteId: (itemId: string, itemType: 'page' | 'drive') => string | undefined;
}

export const useFavorites = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      pageIds: new Set(),
      driveIds: new Set(),
      isLoading: false,
      isSynced: false,

      fetchFavorites: async () => {
        const state = get();
        if (state.isLoading) return;

        set({ isLoading: true });
        try {
          const response = await fetchWithAuth('/api/user/favorites');
          if (!response.ok) {
            throw new Error(`Failed to fetch favorites: ${response.status}`);
          }
          const data = await response.json() as { favorites: FavoriteItem[] };
          const favorites = data.favorites || [];

          const pageIds = new Set<string>();
          const driveIds = new Set<string>();

          for (const fav of favorites) {
            if (fav.itemType === 'page' && fav.page) {
              pageIds.add(fav.page.id);
            } else if (fav.itemType === 'drive' && fav.drive) {
              driveIds.add(fav.drive.id);
            }
          }

          set({ favorites, pageIds, driveIds, isSynced: true, isLoading: false });
        } catch (error) {
          console.error('Error fetching favorites:', error);
          set({ isLoading: false, isSynced: false });
        }
      },

      addFavorite: async (id: string, itemType: 'page' | 'drive' = 'page') => {
        // Snapshot the lookup Sets so we can roll back if the server can't be reached
        const prevPageIds = new Set(get().pageIds);
        const prevDriveIds = new Set(get().driveIds);

        // Optimistic update using functional set to prevent race conditions
        if (itemType === 'page') {
          set(state => ({ pageIds: new Set(state.pageIds).add(id) }));
        } else {
          set(state => ({ driveIds: new Set(state.driveIds).add(id) }));
        }

        try {
          await post('/api/user/favorites', { itemType, itemId: id });
          // Refetch to get the full favorite object with ID and reconcile with server
          await get().fetchFavorites();
        } catch (error) {
          // The POST can fail with 409 ("already favorited") when this device's
          // cache was stale. Reconcile with the server: if the item ends up
          // favorited, treat it as success; otherwise surface the error.
          await get().fetchFavorites();
          if (get().isSynced) {
            // Server state is now authoritative (fetchFavorites overwrote the Sets);
            // succeed if it's favorited, otherwise report the original error.
            if (get().isFavorite(id, itemType)) {
              return;
            }
            throw error;
          }
          // Couldn't reach the server to confirm — roll back the optimistic update
          set({ pageIds: prevPageIds, driveIds: prevDriveIds });
          throw error;
        }
      },

      removeFavorite: async (id: string, itemType: 'page' | 'drive' = 'page') => {
        const matches = (f: FavoriteItem) =>
          (itemType === 'page' && f.page?.id === id) ||
          (itemType === 'drive' && f.drive?.id === id);

        // We need the favorite's DB id to delete it. If this device's cache is
        // stale and doesn't contain the entry, reconcile with the server first —
        // otherwise the removal would silently no-op and the favorite would
        // reappear on the next sync.
        let favorite = get().favorites.find(matches);
        if (!favorite) {
          await get().fetchFavorites();
          favorite = get().favorites.find(matches);
        }

        if (!favorite) {
          // Genuinely not favorited on the server — just make sure the local
          // lookup Sets are clean so the star reflects reality.
          set(state => {
            const newPageIds = new Set(state.pageIds);
            const newDriveIds = new Set(state.driveIds);
            if (itemType === 'page') newPageIds.delete(id);
            else newDriveIds.delete(id);
            return { pageIds: newPageIds, driveIds: newDriveIds };
          });
          return;
        }

        // Snapshot for rollback
        const removeId = favorite.id;
        const prevFavorites = get().favorites;
        const prevPageIds = new Set(get().pageIds);
        const prevDriveIds = new Set(get().driveIds);

        // Optimistic removal from both the favorites array and the lookup Sets
        set(state => {
          const newPageIds = new Set(state.pageIds);
          const newDriveIds = new Set(state.driveIds);
          if (itemType === 'page') newPageIds.delete(id);
          else newDriveIds.delete(id);
          return {
            favorites: state.favorites.filter(f => f.id !== removeId),
            pageIds: newPageIds,
            driveIds: newDriveIds,
          };
        });

        try {
          await del(`/api/user/favorites/${removeId}`);
        } catch (error) {
          // Rollback on error
          set({ favorites: prevFavorites, pageIds: prevPageIds, driveIds: prevDriveIds });
          throw error;
        }
      },

      removeFavoriteById: async (favoriteId: string) => {
        const favorite = get().favorites.find(f => f.id === favoriteId);

        if (!favorite) return;

        // Capture what we're removing for rollback
        const removedPageId = favorite.page?.id;
        const removedDriveId = favorite.drive?.id;

        // Optimistic update using functional set to prevent race conditions
        set(state => {
          const newFavorites = state.favorites.filter(f => f.id !== favoriteId);
          const newPageIds = new Set(state.pageIds);
          const newDriveIds = new Set(state.driveIds);

          if (removedPageId) newPageIds.delete(removedPageId);
          if (removedDriveId) newDriveIds.delete(removedDriveId);

          return { favorites: newFavorites, pageIds: newPageIds, driveIds: newDriveIds };
        });

        try {
          await del(`/api/user/favorites/${favoriteId}`);
        } catch (error) {
          // Rollback using functional set
          set(state => {
            const restoredFavorites = [...state.favorites, favorite];
            const restoredPageIds = new Set(state.pageIds);
            const restoredDriveIds = new Set(state.driveIds);

            if (removedPageId) restoredPageIds.add(removedPageId);
            if (removedDriveId) restoredDriveIds.add(removedDriveId);

            return { favorites: restoredFavorites, pageIds: restoredPageIds, driveIds: restoredDriveIds };
          });
          throw error;
        }
      },

      isFavorite: (id: string, itemType?: 'page' | 'drive') => {
        const state = get();
        if (itemType === 'drive') {
          return state.driveIds.has(id);
        }
        // Default to page for backward compatibility
        return state.pageIds.has(id);
      },

      getFavoriteId: (itemId: string, itemType: 'page' | 'drive') => {
        const state = get();
        const favorite = state.favorites.find(f => {
          if (itemType === 'page' && f.page?.id === itemId) return true;
          if (itemType === 'drive' && f.drive?.id === itemId) return true;
          return false;
        });
        return favorite?.id;
      },
    }),
    {
      name: 'favorites-storage',
      storage: createJSONStorage(() => localStorage, {
        reviver: (key, value) => {
          if ((key === 'pageIds' || key === 'driveIds') && Array.isArray(value)) {
            return new Set(value);
          }
          return value;
        },
        replacer: (key, value) => {
          if ((key === 'pageIds' || key === 'driveIds') && value instanceof Set) {
            return Array.from(value);
          }
          return value;
        },
      }),
      // NOTE: `isSynced` is deliberately NOT persisted. The persisted copy is only
      // a fast first-paint cache; on every load `isSynced` rehydrates as false so
      // the store revalidates against the database (stale-while-revalidate). This
      // is what keeps favorites consistent across devices.
      partialize: (state) => ({
        favorites: state.favorites,
        pageIds: state.pageIds,
        driveIds: state.driveIds,
      }),
      // Force `isSynced` back to false on every rehydrate. Not persisting it is
      // not enough: users upgrading from a build that DID persist it still have
      // `isSynced: true` in localStorage, and the default merge would restore it —
      // causing the load-time revalidation to be skipped. Overriding here
      // guarantees every load revalidates against the server.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<FavoritesState>),
        isSynced: false,
      }),
    }
  )
);

/**
 * Keeps the favorites store in sync with the server.
 *
 * Favorites are database-backed; the persisted localStorage copy is only a fast
 * first-paint cache. Because `isSynced` is not persisted, every mount revalidates
 * against the server. We additionally revalidate when the tab/app regains focus
 * so a device that was in the background (e.g. mobile) picks up changes made on
 * another device. `fetchFavorites` de-dupes concurrent calls via `isLoading`, so
 * mounting this in several components is safe.
 */
export function useFavoritesSync(): void {
  const fetchFavorites = useFavorites((s) => s.fetchFavorites);
  const isSynced = useFavorites((s) => s.isSynced);
  const lastRevalidatedAt = useRef(0);

  useEffect(() => {
    if (!isSynced) {
      fetchFavorites();
    }
  }, [isSynced, fetchFavorites]);

  useEffect(() => {
    const revalidate = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      // Throttle bursts (focus + visibilitychange can fire together)
      const now = Date.now();
      if (now - lastRevalidatedAt.current < 3000) {
        return;
      }
      lastRevalidatedAt.current = now;
      fetchFavorites();
    };

    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [fetchFavorites]);
}
