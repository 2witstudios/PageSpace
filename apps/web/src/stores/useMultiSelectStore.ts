import { create } from 'zustand';

export interface SelectedPageInfo {
  id: string;
  title: string;
  type: string;
  driveId: string;
  parentId: string | null;
}

interface MultiSelectState {
  // Mode and selection state
  isMultiSelectMode: boolean;
  selectedPages: Map<string, SelectedPageInfo>;

  // Drive context (which drive is in multi-select mode)
  activeDriveId: string | null;

  // Actions
  enterMultiSelectMode: (driveId: string) => void;
  exitMultiSelectMode: () => void;
  toggleMultiSelectMode: (driveId: string) => void;

  selectPage: (page: SelectedPageInfo) => void;
  deselectPage: (pageId: string) => void;
  togglePageSelection: (page: SelectedPageInfo) => void;

  selectAll: (pages: SelectedPageInfo[]) => void;
  clearSelection: () => void;

  isSelected: (pageId: string) => boolean;
  getSelectedCount: () => number;
  getSelectedPages: () => SelectedPageInfo[];
}

export const useMultiSelectStore = create<MultiSelectState>((set, get) => ({
  isMultiSelectMode: false,
  selectedPages: new Map(),
  activeDriveId: null,

  enterMultiSelectMode: (driveId: string) => {
    set({
      isMultiSelectMode: true,
      activeDriveId: driveId,
      selectedPages: new Map(),
    });
  },

  exitMultiSelectMode: () => {
    set({
      isMultiSelectMode: false,
      activeDriveId: null,
      selectedPages: new Map(),
    });
  },

  toggleMultiSelectMode: (driveId: string) => {
    const { isMultiSelectMode, activeDriveId } = get();
    if (isMultiSelectMode && activeDriveId === driveId) {
      get().exitMultiSelectMode();
    } else {
      get().enterMultiSelectMode(driveId);
    }
  },

  selectPage: (page: SelectedPageInfo) => {
    const newSelected = new Map(get().selectedPages);
    newSelected.set(page.id, page);
    set({ selectedPages: newSelected });
  },

  deselectPage: (pageId: string) => {
    const newSelected = new Map(get().selectedPages);
    newSelected.delete(pageId);
    set({ selectedPages: newSelected });
  },

  togglePageSelection: (page: SelectedPageInfo) => {
    const { selectedPages } = get();
    if (selectedPages.has(page.id)) {
      get().deselectPage(page.id);
    } else {
      get().selectPage(page);
    }
  },

  selectAll: (pages: SelectedPageInfo[]) => {
    const newSelected = new Map<string, SelectedPageInfo>();
    for (const page of pages) {
      newSelected.set(page.id, page);
    }
    set({ selectedPages: newSelected });
  },

  clearSelection: () => {
    set({ selectedPages: new Map() });
  },

  isSelected: (pageId: string) => {
    return get().selectedPages.has(pageId);
  },

  getSelectedCount: () => {
    return get().selectedPages.size;
  },

  getSelectedPages: () => {
    return Array.from(get().selectedPages.values());
  },
}));

// Selector helpers for performance
export const selectIsMultiSelectMode = (state: MultiSelectState) => state.isMultiSelectMode;
export const selectActiveDriveId = (state: MultiSelectState) => state.activeDriveId;
export const selectSelectedCount = (state: MultiSelectState) => state.selectedPages.size;
