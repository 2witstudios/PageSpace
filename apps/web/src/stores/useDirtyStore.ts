import { create } from 'zustand';

interface DirtyStore {
  dirtyFlags: Record<string, boolean>;
  setDirty: (id: string, isDirty: boolean) => void;
  isDirty: (id: string) => boolean;
  hasDirtyDocuments: () => boolean;
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
}));