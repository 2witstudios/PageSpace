import { useCallback, useMemo, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { useDocumentManagerStore, DocumentState } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';
import { toast } from 'sonner';
import { patch, fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';

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
  const socket = useSocket();

  // Generate a stable session ID for this editing session
  // This groups related edits in the activity log
  // Resets when user navigates away (component remounts)
  const [sessionId] = useState(() => createId());

  const saveDocument = useCallback(
    async (content: string) => {
      try {
        // Record when save started to detect if updates happened during save
        const saveStartTime = Date.now();

        markAsSaving(pageId);

        // Include socket ID in request headers to prevent self-refetch loop
        const headers: Record<string, string> = {};
        if (socket?.id) {
          headers['X-Socket-ID'] = socket.id;
        }

        // Pass changeGroupId to group related edits in activity log
        await patch(`/api/pages/${pageId}`, { content, changeGroupId: sessionId }, { headers });

        // Only mark as saved if NO updates happened since save started
        // This prevents showing "Saved" when user typed during the save
        const currentDoc = useDocumentManagerStore.getState().documents.get(pageId);

        // Check: content matches AND no updates during save (lastUpdateTime < saveStartTime)
        if (currentDoc &&
            currentDoc.content === content &&
            currentDoc.lastUpdateTime < saveStartTime) {
          markAsSaved(pageId);
          // Clear dirty flag from useDirtyStore on successful save
          useDirtyStore.getState().clearDirty(pageId);
        } else {
          // Content changed while saving - remove from saving state but keep dirty
          const state = useDocumentManagerStore.getState();
          const newSaving = new Set(state.savingDocuments);
          newSaving.delete(pageId);
          useDocumentManagerStore.setState({ savingDocuments: newSaving });
        }

        return true;
      } catch (error) {
        console.error('Save failed:', error);
        toast.error('Failed to save document');

        // Remove from saving state but keep isDirty true since save failed
        const state = useDocumentManagerStore.getState();
        const newSaving = new Set(state.savingDocuments);
        newSaving.delete(pageId);
        useDocumentManagerStore.setState({ savingDocuments: newSaving });

        throw error;
      }
    },
    [pageId, markAsSaving, markAsSaved, socket, sessionId]
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
  const [isLoading, setIsLoading] = useState(false);

  // Initialize document on mount - fetches content if not provided
  const initializeAndActivate = useCallback(async () => {
    // Check if document already exists - if so, just activate it
    const existingDoc = useDocumentManagerStore.getState().documents.get(pageId);
    if (existingDoc) {
      setActiveDocument(pageId);
      return;
    }

    // If initialContent provided, use it (optional optimization)
    if (initialContent !== undefined) {
      const createDocument = useDocumentManagerStore.getState().createDocument;
      createDocument(pageId, initialContent);
      setActiveDocument(pageId);
      return;
    }

    // Otherwise, fetch content from API
    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (response.ok) {
        const page = await response.json();
        const createDocument = useDocumentManagerStore.getState().createDocument;
        createDocument(pageId, page.content || '');
        setActiveDocument(pageId);
      } else {
        console.error('Failed to fetch page content:', response.status);
        const createDocument = useDocumentManagerStore.getState().createDocument;
        createDocument(pageId, ''); // Fallback to empty
        setActiveDocument(pageId);
      }
    } catch (error) {
      console.error('Failed to fetch page content:', error);
      const createDocument = useDocumentManagerStore.getState().createDocument;
      createDocument(pageId, ''); // Fallback to empty
      setActiveDocument(pageId);
    } finally {
      setIsLoading(false);
    }
  }, [initialContent, setActiveDocument, pageId]);
  
  // Content update handler for user edits
  const updateContent = useCallback(
    (newContent: string) => {
      const currentDoc = useDocumentManagerStore.getState().documents.get(pageId);

      // Only update if content actually changed
      if (currentDoc?.content === newContent) return;

      // Update content with timestamp and dirty flag
      const updateDocument = useDocumentManagerStore.getState().updateDocument;
      updateDocument(pageId, {
        content: newContent,
        lastUpdateTime: Date.now(), // Track when content was last updated
        isDirty: true, // Always mark as dirty on user edits
      });

      // Also update useDirtyStore for browser "unsaved changes" warning
      useDirtyStore.getState().setDirty(pageId, true);
    },
    [pageId]
  );
  
  // Content update handler for server updates (already saved)
  const updateContentFromServer = useCallback(
    (newContent: string) => {
      const now = Date.now();
      const updateDocument = useDocumentManagerStore.getState().updateDocument;
      updateDocument(pageId, {
        content: newContent,
        isDirty: false,
        lastSaved: now,
        lastUpdateTime: now, // Update timestamp for server updates too
      });
    },
    [pageId]
  );

  // Auto-save with debouncing
  const saveWithDebounce = useCallback(
    (content: string, delay = 1000) => {
      const document = useDocumentManagerStore.getState().documents.get(pageId);
      if (document?.saveTimeout) {
        clearTimeout(document.saveTimeout);
      }

      const timeout = setTimeout(() => {
        saving.saveDocument(content).catch(console.error);
      }, delay);

      const updateDocument = useDocumentManagerStore.getState().updateDocument;
      updateDocument(pageId, { saveTimeout: timeout });
    },
    [pageId, saving]
  );
  
  // Force save (immediate)
  const forceSave = useCallback(async () => {
    const document = useDocumentManagerStore.getState().documents.get(pageId);
    if (!document?.isDirty) return false;

    // Clear debounced save
    if (document.saveTimeout) {
      clearTimeout(document.saveTimeout);
    }

    return saving.saveDocument(document.content);
  }, [pageId, saving]);
  
  return {
    document: documentState.document,
    isLoading,
    isSaving: saving.isSaving,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
    clearDocument: documentState.clearDocument,
  };
};