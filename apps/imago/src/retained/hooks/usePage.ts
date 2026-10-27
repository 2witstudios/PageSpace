import { create } from 'zustand';

interface PageState {
  pageId: string | null;
  setPageId: (pageId: string | null) => void;
}

export const usePageStore = create<PageState>((set) => ({
  pageId: null,
  setPageId: (pageId) => set({ pageId }),
}));