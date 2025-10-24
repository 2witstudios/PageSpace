import { create } from 'zustand';

/**
 * Store for sharing editor DOM element between DocumentView and ExportDropdown
 * This allows the print handler to access the pagination decorations
 */
interface EditorDomStore {
  editorElement: HTMLElement | null;
  setEditorElement: (element: HTMLElement | null) => void;
}

export const useEditorDomStore = create<EditorDomStore>((set) => ({
  editorElement: null,
  setEditorElement: (element) => set({ editorElement: element }),
}));
