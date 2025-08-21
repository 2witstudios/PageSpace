import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FavoritesState {
  favorites: Set<string>;
  addFavorite: (id: string) => void;
  removeFavorite: (id: string) => void;
  isFavorite: (id: string) => boolean;
}

import { createJSONStorage } from 'zustand/middleware';

export const useFavorites = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: new Set(),
      addFavorite: (id: string) =>
        set((state) => ({
          favorites: new Set(state.favorites).add(id),
        })),
      removeFavorite: (id: string) =>
        set((state) => {
          const newFavorites = new Set(state.favorites);
          newFavorites.delete(id);
          return { favorites: newFavorites };
        }),
      isFavorite: (id: string) => get().favorites.has(id),
    }),
    {
      name: 'favorites-storage',
      storage: createJSONStorage(() => localStorage, {
        reviver: (key, value) => {
          if (key === 'favorites' && Array.isArray(value)) {
            return new Set(value);
          }
          return value;
        },
        replacer: (key, value) => {
          if (key === 'favorites' && value instanceof Set) {
            return Array.from(value);
          }
          return value;
        },
      }),
    }
  )
);