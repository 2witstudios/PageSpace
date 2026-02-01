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
        // Optimistic update
        const prevState = get();
        if (itemType === 'page') {
          set({ pageIds: new Set(prevState.pageIds).add(id) });
        } else {
          set({ driveIds: new Set(prevState.driveIds).add(id) });
        }

        try {
          await post('/api/user/favorites', { itemType, itemId: id });
          // Refetch to get the full favorite object with ID
          await get().fetchFavorites();
        } catch (error) {
          // Rollback on error
          if (itemType === 'page') {
            const rollbackIds = new Set(prevState.pageIds);
            rollbackIds.delete(id);
            set({ pageIds: rollbackIds });
          } else {
            const rollbackIds = new Set(prevState.driveIds);
            rollbackIds.delete(id);
            set({ driveIds: rollbackIds });
          }
          throw error;
        }
      },

      removeFavorite: async (id: string, itemType: 'page' | 'drive' = 'page') => {
        const state = get();

        // Find the favorite ID
        const favorite = state.favorites.find(f => {
          if (itemType === 'page' && f.page?.id === id) return true;
          if (itemType === 'drive' && f.drive?.id === id) return true;
          return false;
        });

        if (!favorite) {
          // Not found in synced data - just remove from local set
          if (itemType === 'page') {
            const newPageIds = new Set(state.pageIds);
            newPageIds.delete(id);
            set({ pageIds: newPageIds });
          } else {
            const newDriveIds = new Set(state.driveIds);
            newDriveIds.delete(id);
            set({ driveIds: newDriveIds });
          }
          return;
        }

        // Optimistic update
        if (itemType === 'page') {
          const newPageIds = new Set(state.pageIds);
          newPageIds.delete(id);
          set({ pageIds: newPageIds });
        } else {
          const newDriveIds = new Set(state.driveIds);
          newDriveIds.delete(id);
          set({ driveIds: newDriveIds });
        }

        try {
          await del(`/api/user/favorites/${favorite.id}`);
          // Refetch to sync state
          await get().fetchFavorites();
        } catch (error) {
          // Rollback on error
          if (itemType === 'page') {
            set({ pageIds: new Set(state.pageIds).add(id) });
          } else {
            set({ driveIds: new Set(state.driveIds).add(id) });
          }
          throw error;
        }
      },

      removeFavoriteById: async (favoriteId: string) => {
        const state = get();
        const favorite = state.favorites.find(f => f.id === favoriteId);

        if (!favorite) return;

        // Optimistic update
        const newFavorites = state.favorites.filter(f => f.id !== favoriteId);
        const newPageIds = new Set(state.pageIds);
        const newDriveIds = new Set(state.driveIds);

        if (favorite.page) newPageIds.delete(favorite.page.id);
        if (favorite.drive) newDriveIds.delete(favorite.drive.id);

        set({ favorites: newFavorites, pageIds: newPageIds, driveIds: newDriveIds });

        try {
          await del(`/api/user/favorites/${favoriteId}`);
        } catch (error) {
          // Rollback
          set({ favorites: state.favorites, pageIds: state.pageIds, driveIds: state.driveIds });
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
      partialize: (state) => ({
        favorites: state.favorites,
        pageIds: state.pageIds,
        driveIds: state.driveIds,
        isSynced: state.isSynced,
      }),
    }
  )
);
