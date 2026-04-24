import { create } from 'zustand';

export interface DocumentState {
  id: string;
  content: string;
  contentMode: 'html' | 'markdown';
  isDirty: boolean;
  lastSaved: number;
  lastUpdateTime: number;
  saveTimeout?: NodeJS.Timeout;
  revision?: number;
}

export interface DocumentManagerState {
  documents: Map<string, DocumentState>;
  activeDocumentId: string | null;
  savingDocuments: Set<string>;

  upsertDocument: (pageId: string, content: string, contentMode: 'html' | 'markdown', revision?: number) => void;
  updateDocument: (pageId: string, updates: Partial<DocumentState>) => void;
  getDocument: (pageId: string) => DocumentState | undefined;
  setActiveDocument: (pageId: string | null) => void;
  getActiveDocument: () => DocumentState | undefined;
  markAsSaving: (pageId: string) => void;
  markAsSaved: (pageId: string) => void;
  clearDocument: (pageId: string) => void;
  clearAllDocuments: () => void;
}

export const useDocumentManagerStore = create<DocumentManagerState>((set, get) => ({
  documents: new Map(),
  activeDocumentId: null,
  savingDocuments: new Set(),

  upsertDocument: (pageId, content, contentMode, revision) => {
    const state = get();
    const existing = state.documents.get(pageId);
    const now = Date.now();
    const newDocuments = new Map(state.documents);

    if (existing?.isDirty) {
      // Preserve unsaved edits — only update non-content metadata
      newDocuments.set(pageId, {
        ...existing,
        contentMode,
        ...(revision !== undefined ? { revision } : {}),
      });
    } else {
      newDocuments.set(pageId, {
        id: pageId,
        content,
        contentMode,
        isDirty: false,
        lastSaved: now,
        lastUpdateTime: now,
        ...(existing?.saveTimeout ? { saveTimeout: existing.saveTimeout } : {}),
        ...(revision !== undefined ? { revision } : {}),
      });
    }

    set({ documents: newDocuments });
  },

  updateDocument: (pageId, updates) => {
    const state = get();
    const document = state.documents.get(pageId);

    if (document) {
      const newDocuments = new Map(state.documents);
      newDocuments.set(pageId, { ...document, ...updates });
      set({ documents: newDocuments });
    }
  },

  getDocument: (pageId) => {
    return get().documents.get(pageId);
  },

  setActiveDocument: (pageId) => {
    set({ activeDocumentId: pageId });
  },

  getActiveDocument: () => {
    const state = get();
    if (!state.activeDocumentId) return undefined;
    return state.documents.get(state.activeDocumentId);
  },

  markAsSaving: (pageId) => {
    const state = get();
    const newSaving = new Set(state.savingDocuments);
    newSaving.add(pageId);
    set({ savingDocuments: newSaving });
  },

  markAsSaved: (pageId) => {
    const state = get();
    const newSaving = new Set(state.savingDocuments);
    newSaving.delete(pageId);
    set({ savingDocuments: newSaving });
    get().updateDocument(pageId, { isDirty: false, lastSaved: Date.now() });
  },

  clearDocument: (pageId) => {
    const state = get();
    const newDocuments = new Map(state.documents);
    newDocuments.delete(pageId);

    const newSaving = new Set(state.savingDocuments);
    newSaving.delete(pageId);

    set({
      documents: newDocuments,
      savingDocuments: newSaving,
      activeDocumentId: state.activeDocumentId === pageId ? null : state.activeDocumentId,
    });
  },

  clearAllDocuments: () => {
    set({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
    });
  },
}));
