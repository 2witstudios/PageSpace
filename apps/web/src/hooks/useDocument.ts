import { useCallback, useMemo, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { useDocumentManagerStore, DocumentState } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
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

  const clearSavingState = useCallback((id: string) => {
    const state = useDocumentManagerStore.getState();
    const newSaving = new Set(state.savingDocuments);
    newSaving.delete(id);
    useDocumentManagerStore.setState({ savingDocuments: newSaving });
  }, []);

  const saveDocument = useCallback(
    async (content: string) => {
      try {
        // Record when save started to detect if updates happened during save
        const saveStartTime = Date.now();

        markAsSaving(pageId);

        // Read current revision for optimistic locking
        const docBeforeSave = useDocumentManagerStore.getState().documents.get(pageId);
        const expectedRevision = docBeforeSave?.revision;

        // Include socket ID in request headers to prevent self-refetch loop
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (socket?.id) {
          headers['X-Socket-ID'] = socket.id;
        }

        // Pass changeGroupId and expectedRevision to detect concurrent edits
        const response = await fetchWithAuth(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ content, expectedRevision, changeGroupId: sessionId }),
        });

        if (!response.ok) {
          if (response.status === 409) {
            // Revision conflict - another tab/user modified the page
            // Log the discarded local content so it can be recovered from dev tools
            console.warn(
              `[conflict] Page ${pageId}: local edits discarded. Content was:`,
              content
            );
            toast.error('Document was modified elsewhere. Your local copy has been updated.', {
              id: `conflict-${pageId}`,
            });
            // Refetch latest to update revision and content, stopping the retry loop
            try {
              const freshResponse = await fetchWithAuth(`/api/pages/${pageId}`);
              if (freshResponse.ok) {
                const freshPage = await freshResponse.json();
                useDocumentManagerStore.getState().updateDocument(pageId, {
                  content: freshPage.content ?? '',
                  revision: freshPage.revision,
                  isDirty: false,
                  lastSaved: Date.now(),
                  lastUpdateTime: Date.now(),
                });
                useDirtyStore.getState().clearDirty(pageId);
              }
            } catch {
              // Refetch failed - user can still manually refresh
            }
            clearSavingState(pageId);
            return false;
          }
          const errorData = await response.json().catch(() => ({ error: 'Save failed' }));
          throw new Error(errorData.error || 'Save failed');
        }

        const savedPage = await response.json();

        // Update stored revision from server response
        useDocumentManagerStore.getState().updateDocument(pageId, { revision: savedPage.revision });

        // Only mark as saved if NO updates happened since save started
        // This prevents showing "Saved" when user typed during the save
        const currentDoc = useDocumentManagerStore.getState().documents.get(pageId);

        // Check: content matches AND no updates during save (lastUpdateTime < saveStartTime)
        if (currentDoc &&
            currentDoc.content === content &&
            currentDoc.lastUpdateTime < saveStartTime) {
          markAsSaved(pageId);
          useDirtyStore.getState().clearDirty(pageId);
        } else {
          // Content changed while saving - keep dirty
          clearSavingState(pageId);
        }

        return true;
      } catch (error) {
        console.error('Save failed:', error);
        toast.error('Failed to save document');
        clearSavingState(pageId);
        throw error;
      }
    },
    [pageId, markAsSaving, markAsSaved, clearSavingState, socket, sessionId]
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
        const store = useDocumentManagerStore.getState();
        store.createDocument(pageId, page.content || '');
        if (page.revision !== undefined) {
          store.updateDocument(pageId, { revision: page.revision });
        }
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
    (newContent: string, revision?: number) => {
      const now = Date.now();
      const updateDocument = useDocumentManagerStore.getState().updateDocument;
      const updates: Partial<DocumentState> = {
        content: newContent,
        isDirty: false,
        lastSaved: now,
        lastUpdateTime: now,
      };
      if (revision !== undefined) updates.revision = revision;
      updateDocument(pageId, updates);
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