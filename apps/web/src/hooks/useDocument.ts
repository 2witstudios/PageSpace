import { useCallback, useMemo } from 'react';
import { useDocumentManagerStore, DocumentState } from '@/stores/useDocumentManagerStore';
import { toast } from 'sonner';

// Document state selectors
export const useDocumentState = (pageId: string) => {
  const document = useDocumentManagerStore(
    useCallback((state) => state.documents.get(pageId), [pageId])
  );
  
  const createDocument = useDocumentManagerStore((state) => state.createDocument);
  const updateDocument = useDocumentManagerStore((state) => state.updateDocument);
  const clearDocument = useDocumentManagerStore((state) => state.clearDocument);
  
  // Initialize document if it doesn't exist
  const initializeDocument = useCallback(
    (initialContent?: string) => {
      if (!document) {
        createDocument(pageId, initialContent);
      }
    },
    [document, createDocument, pageId]
  );
  
  return {
    document,
    initializeDocument,
    updateDocument: useCallback(
      (updates: Partial<DocumentState>) => updateDocument(pageId, updates),
      [updateDocument, pageId]
    ),
    clearDocument: useCallback(
      () => clearDocument(pageId),
      [clearDocument, pageId]
    ),
  };
};

export const useActiveDocument = () => {
  const activeDocumentId = useDocumentManagerStore((state) => state.activeDocumentId);
  const getActiveDocument = useDocumentManagerStore((state) => state.getActiveDocument);
  const setActiveDocument = useDocumentManagerStore((state) => state.setActiveDocument);
  
  const activeDocument = useMemo(() => getActiveDocument(), [getActiveDocument]);
  
  return {
    activeDocumentId,
    activeDocument,
    setActiveDocument,
  };
};

export const useDocumentSaving = (pageId: string) => {
  const isSaving = useDocumentManagerStore(
    useCallback((state) => state.savingDocuments.has(pageId), [pageId])
  );
  
  const markAsSaving = useDocumentManagerStore((state) => state.markAsSaving);
  const markAsSaved = useDocumentManagerStore((state) => state.markAsSaved);
  
  const saveDocument = useCallback(
    async (content: string) => {
      try {
        markAsSaving(pageId);
        
        const response = await fetch(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        
        if (!response.ok) {
          throw new Error(`Failed to save: ${response.status}`);
        }
        
        markAsSaved(pageId);
        
        return true;
      } catch (error) {
        console.error('Save failed:', error);
        toast.error('Failed to save document');
        markAsSaved(pageId); // Remove from saving state even on error
        throw error;
      }
    },
    [pageId, markAsSaving, markAsSaved]
  );
  
  return {
    isSaving,
    saveDocument,
  };
};

// Combined document hook for components
export const useDocument = (pageId: string, initialContent?: string) => {
  const documentState = useDocumentState(pageId);
  const saving = useDocumentSaving(pageId);
  const { setActiveDocument } = useActiveDocument();
  
  // Initialize document on mount
  const initializeAndActivate = useCallback(() => {
    documentState.initializeDocument(initialContent);
    setActiveDocument(pageId);
  }, [documentState, initialContent, setActiveDocument, pageId]);
  
  // Content update handler for user edits
  const updateContent = useCallback(
    (newContent: string) => {
      documentState.updateDocument({
        content: newContent,
        isDirty: true,
      });
    },
    [documentState]
  );
  
  // Content update handler for server updates (already saved)
  const updateContentFromServer = useCallback(
    (newContent: string) => {
      documentState.updateDocument({
        content: newContent,
        isDirty: false,
        lastSaved: Date.now(),
      });
    },
    [documentState]
  );
  
  // Auto-save with debouncing
  const saveWithDebounce = useCallback(
    (content: string, delay = 1000) => {
      const document = documentState.document;
      if (document?.saveTimeout) {
        clearTimeout(document.saveTimeout);
      }
      
      const timeout = setTimeout(() => {
        saving.saveDocument(content).catch(console.error);
      }, delay);
      
      documentState.updateDocument({ saveTimeout: timeout });
    },
    [documentState, saving]
  );
  
  // Force save (immediate)
  const forceSave = useCallback(async () => {
    if (!documentState.document?.isDirty) return false;
    
    // Clear debounced save
    if (documentState.document.saveTimeout) {
      clearTimeout(documentState.document.saveTimeout);
    }
    
    return saving.saveDocument(documentState.document.content);
  }, [documentState, saving]);
  
  return {
    document: documentState.document,
    isSaving: saving.isSaving,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
    clearDocument: documentState.clearDocument,
  };
};