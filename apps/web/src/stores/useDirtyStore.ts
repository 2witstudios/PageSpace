import { create } from 'zustand';

interface DirtyStore {
  dirtyFlags: Record<string, boolean>;
  setDirty: (id: string, isDirty: boolean) => void;
  isDirty: (id: string) => boolean;
  hasDirtyDocuments: () => boolean;
  clearDirty: (id: string) => void;
  clearAllDirty: () => void;
}

export const useDirtyStore = create<DirtyStore>((set, get) => ({
  dirtyFlags: {},
  setDirty: (id, isDirty) => {
    set((state) => ({
      dirtyFlags: {
        ...state.dirtyFlags,
        [id]: isDirty,
      },
    }));
  },
  isDirty: (id) => {
    return get().dirtyFlags[id] || false;
  },
  hasDirtyDocuments: () => {
    return Object.values(get().dirtyFlags).some(Boolean);
  },
  clearDirty: (id) => {
    set((state) => {
      const { [id]: _, ...rest } = state.dirtyFlags;
      return { dirtyFlags: rest };
    });
  },
  clearAllDirty: () => {
    set({ dirtyFlags: {} });
  },
}));