import { create } from 'zustand';

interface FindStore {
  isOpen: boolean;
  query: string;
  currentIndex: number;
  totalMatches: number;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  next: () => void;
  prev: () => void;
  reportMatches: (count: number) => void;
  reset: () => void;
}

export const useFindStore = create<FindStore>((set, get) => ({
  isOpen: false,
  query: '',
  currentIndex: 0,
  totalMatches: 0,

  open: () => set({ isOpen: true }),

  close: () => set({ isOpen: false, query: '', currentIndex: 0, totalMatches: 0 }),

  setQuery: (query) => set({ query, currentIndex: 0, totalMatches: 0 }),

  next: () => {
    const { currentIndex, totalMatches } = get();
    if (totalMatches === 0) return;
    set({ currentIndex: (currentIndex + 1) % totalMatches });
  },

  prev: () => {
    const { currentIndex, totalMatches } = get();
    if (totalMatches === 0) return;
    set({ currentIndex: (currentIndex - 1 + totalMatches) % totalMatches });
  },

  reportMatches: (count) => {
    const { currentIndex } = get();
    set({
      totalMatches: count,
      currentIndex: count === 0 ? 0 : Math.min(currentIndex, count - 1),
    });
  },

  reset: () => set({ isOpen: false, query: '', currentIndex: 0, totalMatches: 0 }),
}));
