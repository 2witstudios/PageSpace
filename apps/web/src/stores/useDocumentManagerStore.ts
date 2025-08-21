import { create } from 'zustand';

export interface DocumentState {
  id: string;
  content: string;
  isDirty: boolean;
  version: number;
  lastSaved: number;
  saveTimeout?: NodeJS.Timeout;
}

export interface DocumentManagerState {
  // Document storage
  documents: Map<string, DocumentState>;
  activeDocumentId: string | null;
  
  // Saving state
  savingDocuments: Set<string>;
  
  // Actions
  createDocument: (pageId: string, initialContent?: string) => void;
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
  // Initial state
  documents: new Map(),
  activeDocumentId: null,
  savingDocuments: new Set(),
  
  // Actions
  createDocument: (pageId: string, initialContent = '') => {
    const state = get();
    const newDocuments = new Map(state.documents);
    
    if (!newDocuments.has(pageId)) {
      newDocuments.set(pageId, {
        id: pageId,
        content: initialContent,
        isDirty: false,
        version: 0,
        lastSaved: Date.now(),
      });
      
      set({ documents: newDocuments });
    }
  },
  
  updateDocument: (pageId: string, updates: Partial<DocumentState>) => {
    const state = get();
    const document = state.documents.get(pageId);
    
    if (document) {
      const newDocuments = new Map(state.documents);
      newDocuments.set(pageId, { ...document, ...updates });
      set({ documents: newDocuments });
    }
  },
  
  getDocument: (pageId: string): DocumentState | undefined => {
    return get().documents.get(pageId);
  },
  
  setActiveDocument: (pageId: string | null) => {
    set({ activeDocumentId: pageId });
  },
  
  getActiveDocument: (): DocumentState | undefined => {
    const state = get();
    if (!state.activeDocumentId) return undefined;
    return state.documents.get(state.activeDocumentId);
  },
  
  markAsSaving: (pageId: string) => {
    const state = get();
    const newSaving = new Set(state.savingDocuments);
    newSaving.add(pageId);
    set({ savingDocuments: newSaving });
  },
  
  markAsSaved: (pageId: string) => {
    const state = get();
    const newSaving = new Set(state.savingDocuments);
    newSaving.delete(pageId);
    set({ savingDocuments: newSaving });
    
    // Update the document's saved timestamp
    get().updateDocument(pageId, {
      isDirty: false,
      lastSaved: Date.now(),
    });
  },
  
  clearDocument: (pageId: string) => {
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