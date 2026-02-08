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
        // Optimistic update using functional set to prevent race conditions
        if (itemType === 'page') {
          set(state => ({ pageIds: new Set(state.pageIds).add(id) }));
        } else {
          set(state => ({ driveIds: new Set(state.driveIds).add(id) }));
        }

        try {
          await post('/api/user/favorites', { itemType, itemId: id });
          // Refetch to get the full favorite object with ID
          await get().fetchFavorites();
        } catch (error) {
          // Rollback on error using functional set
          if (itemType === 'page') {
            set(state => {
              const rollbackIds = new Set(state.pageIds);
              rollbackIds.delete(id);
              return { pageIds: rollbackIds };
            });
          } else {
            set(state => {
              const rollbackIds = new Set(state.driveIds);
              rollbackIds.delete(id);
              return { driveIds: rollbackIds };
            });
          }
          throw error;
        }
      },

      removeFavorite: async (id: string, itemType: 'page' | 'drive' = 'page') => {
        // Find the favorite from current state
        const favorite = get().favorites.find(f => {
          if (itemType === 'page' && f.page?.id === id) return true;
          if (itemType === 'drive' && f.drive?.id === id) return true;
          return false;
        });

        // Optimistic update: remove from both the favorites array and the lookup Sets
        set(state => {
          const newPageIds = new Set(state.pageIds);
          const newDriveIds = new Set(state.driveIds);
          if (itemType === 'page') {
            newPageIds.delete(id);
          } else {
            newDriveIds.delete(id);
          }
          const newFavorites = favorite
            ? state.favorites.filter(f => f.id !== favorite.id)
            : state.favorites;
          return { favorites: newFavorites, pageIds: newPageIds, driveIds: newDriveIds };
        });

        if (!favorite) {
          return;
        }

        try {
          await del(`/api/user/favorites/${favorite.id}`);
        } catch (error) {
          // Rollback on error: restore both the favorites array and the lookup Sets
          set(state => {
            const restoredPageIds = new Set(state.pageIds);
            const restoredDriveIds = new Set(state.driveIds);
            if (itemType === 'page') {
              restoredPageIds.add(id);
            } else {
              restoredDriveIds.add(id);
            }
            return {
              favorites: [...state.favorites, favorite],
              pageIds: restoredPageIds,
              driveIds: restoredDriveIds,
            };
          });
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
      partialize: (state) => ({
        favorites: state.favorites,
        pageIds: state.pageIds,
        driveIds: state.driveIds,
        isSynced: state.isSynced,
      }),
    }
  )
);
