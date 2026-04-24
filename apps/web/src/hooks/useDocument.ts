import { useCallback, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { useDocumentManagerStore, DocumentState } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';

export const useDocumentState = (pageId: string) => {
  const document = useDocumentManagerStore(
    useCallback((state) => state.documents.get(pageId), [pageId])
  );

  const updateDocument = useDocumentManagerStore((state) => state.updateDocument);
  const clearDocument = useDocumentManagerStore((state) => state.clearDocument);

  return {
    document,
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

  return {
    activeDocumentId,
    activeDocument: getActiveDocument(),
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
        const saveStartTime = Date.now();

        markAsSaving(pageId);

        const docBeforeSave = useDocumentManagerStore.getState().documents.get(pageId);
        const expectedRevision = docBeforeSave?.revision;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (socket?.id) {
          headers['X-Socket-ID'] = socket.id;
        }

        const response = await fetchWithAuth(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ content, expectedRevision, changeGroupId: sessionId }),
        });

        if (!response.ok) {
          if (response.status === 409) {
            console.warn(
              `[conflict] Page ${pageId}: local edits discarded. Content was:`,
              content
            );
            toast.error('Document was modified elsewhere. Your local copy has been updated.', {
              id: `conflict-${pageId}`,
            });
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
              // Refetch failed — user can still manually refresh
            }
            clearSavingState(pageId);
            return false;
          }
          const errorData = await response.json().catch(() => ({ error: 'Save failed' }));
          throw new Error(errorData.error || 'Save failed');
        }

        const savedPage = await response.json();

        if (savedPage.revision !== undefined) {
          useDocumentManagerStore.getState().updateDocument(pageId, { revision: savedPage.revision });
        }

        const currentDoc = useDocumentManagerStore.getState().documents.get(pageId);

        if (
          currentDoc &&
          currentDoc.content === content &&
          currentDoc.lastUpdateTime < saveStartTime
        ) {
          markAsSaved(pageId);
          useDirtyStore.getState().clearDirty(pageId);
        } else {
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

export const useDocument = (pageId: string) => {
  const documentState = useDocumentState(pageId);
  const saving = useDocumentSaving(pageId);
  const { setActiveDocument } = useActiveDocument();
  const [isLoading, setIsLoading] = useState(false);

  const initializeAndActivate = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/pages/${pageId}`);
      if (response.ok) {
        const page = await response.json();
        useDocumentManagerStore.getState().upsertDocument(
          pageId,
          page.content || '',
          page.contentMode || 'html',
          page.revision
        );
        setActiveDocument(pageId);
      } else {
        console.error('Failed to fetch page content:', response.status);
        // Only fall back to empty when there is no existing cached content —
        // a transient failure should not blank a valid in-memory document
        if (!useDocumentManagerStore.getState().documents.get(pageId)) {
          useDocumentManagerStore.getState().upsertDocument(pageId, '', 'html');
        }
        setActiveDocument(pageId);
      }
    } catch (error) {
      console.error('Failed to fetch page content:', error);
      if (!useDocumentManagerStore.getState().documents.get(pageId)) {
        useDocumentManagerStore.getState().upsertDocument(pageId, '', 'html');
      }
      setActiveDocument(pageId);
    } finally {
      setIsLoading(false);
    }
  }, [setActiveDocument, pageId]);

  const updateContent = useCallback(
    (newContent: string) => {
      const currentDoc = useDocumentManagerStore.getState().documents.get(pageId);

      if (currentDoc?.content === newContent) return;

      useDocumentManagerStore.getState().updateDocument(pageId, {
        content: newContent,
        lastUpdateTime: Date.now(),
        isDirty: true,
      });

      useDirtyStore.getState().setDirty(pageId, true);
    },
    [pageId]
  );

  const updateContentFromServer = useCallback(
    (newContent: string, revision?: number) => {
      const now = Date.now();
      const updates: Partial<DocumentState> = {
        content: newContent,
        isDirty: false,
        lastSaved: now,
        lastUpdateTime: now,
      };
      if (revision !== undefined) updates.revision = revision;
      useDocumentManagerStore.getState().updateDocument(pageId, updates);
    },
    [pageId]
  );

  const saveWithDebounce = useCallback(
    (content: string, delay = 1000) => {
      const document = useDocumentManagerStore.getState().documents.get(pageId);
      if (document?.saveTimeout) {
        clearTimeout(document.saveTimeout);
      }

      const timeout = setTimeout(() => {
        saving.saveDocument(content).catch(console.error);
      }, delay);

      useDocumentManagerStore.getState().updateDocument(pageId, { saveTimeout: timeout });
    },
    [pageId, saving]
  );

  const forceSave = useCallback(async () => {
    const document = useDocumentManagerStore.getState().documents.get(pageId);
    if (!document?.isDirty) return false;

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
