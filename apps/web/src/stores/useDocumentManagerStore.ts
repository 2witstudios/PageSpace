import { create } from 'zustand';
import type { DocumentConflict } from '@/lib/documents/conflict-resolution';

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
  /**
   * Server copies parked by a 409 while the user decides what to keep.
   * Deliberately NOT merged into `documents` — an entry here means the local
   * buffer is still the user's own text and autosave is paused for that page.
   */
  conflicts: Map<string, DocumentConflict>;

  upsertDocument: (pageId: string, content: string, contentMode: 'html' | 'markdown', revision?: number) => void;
  updateDocument: (pageId: string, updates: Partial<DocumentState>) => void;
  getDocument: (pageId: string) => DocumentState | undefined;
  setActiveDocument: (pageId: string | null) => void;
  getActiveDocument: () => DocumentState | undefined;
  markAsSaving: (pageId: string) => void;
  markAsSaved: (pageId: string) => void;
  clearDocument: (pageId: string) => void;
  clearAllDocuments: () => void;
  setConflict: (pageId: string, conflict: DocumentConflict) => void;
  clearConflict: (pageId: string) => void;
}

export const useDocumentManagerStore = create<DocumentManagerState>((set, get) => ({
  documents: new Map(),
  activeDocumentId: null,
  savingDocuments: new Set(),
  conflicts: new Map(),

  upsertDocument: (pageId, content, contentMode, revision) => {
    const state = get();
    const existing = state.documents.get(pageId);
    const now = Date.now();
    const newDocuments = new Map(state.documents);

    if (existing?.isDirty) {
      // Preserve unsaved edits — only update revision; contentMode stays
      // aligned with the preserved local content to avoid parse mismatch
      newDocuments.set(pageId, {
        ...existing,
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

    const newConflicts = new Map(state.conflicts);
    newConflicts.delete(pageId);

    set({
      documents: newDocuments,
      savingDocuments: newSaving,
      conflicts: newConflicts,
      activeDocumentId: state.activeDocumentId === pageId ? null : state.activeDocumentId,
    });
  },

  clearAllDocuments: () => {
    set({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
      conflicts: new Map(),
    });
  },

  setConflict: (pageId, conflict) => {
    const newConflicts = new Map(get().conflicts);
    newConflicts.set(pageId, conflict);
    set({ conflicts: newConflicts });
  },

  clearConflict: (pageId) => {
    const state = get();
    if (!state.conflicts.has(pageId)) return;
    const newConflicts = new Map(state.conflicts);
    newConflicts.delete(pageId);
    set({ conflicts: newConflicts });
  },
}));
