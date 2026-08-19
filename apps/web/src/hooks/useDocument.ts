import { useCallback, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { useDocumentManagerStore, DocumentState } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';
import {
  canScheduleSave,
  decideConflictOutcome,
  planConflictResolution,
  type ConflictResolutionChoice,
  type ConflictResponseBody,
  type RemotePageSnapshot,
} from '@/lib/documents/conflict-resolution';

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
    async (content: string, options?: { expectedRevision?: number }) => {
      try {
        const saveStartTime = Date.now();

        markAsSaving(pageId);

        const docBeforeSave = useDocumentManagerStore.getState().documents.get(pageId);
        const expectedRevision = options?.expectedRevision ?? docBeforeSave?.revision;

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
            // NEVER replace the user's buffer here. Park the server's copy
            // beside it and let the user choose; `content` / `isDirty` and the
            // dirty store are deliberately left exactly as they are.
            const conflictBody: ConflictResponseBody | null = await response
              .json()
              .catch(() => null);

            let remotePage: RemotePageSnapshot | null = null;
            try {
              const freshResponse = await fetchWithAuth(`/api/pages/${pageId}`);
              if (freshResponse.ok) {
                remotePage = (await freshResponse.json()) as RemotePageSnapshot;
              }
            } catch {
              // Leave remotePage null — decideConflictOutcome reports an error
              // rather than offering a resolution we cannot honour.
            }

            const outcome = decideConflictOutcome({
              conflictBody,
              remotePage,
              detectedAt: Date.now(),
            });

            // Cancel any debounce queued before the conflict was detected —
            // otherwise it fires, 409s again, and the toast loops.
            const pending = useDocumentManagerStore.getState().documents.get(pageId);
            if (pending?.saveTimeout) {
              clearTimeout(pending.saveTimeout);
              useDocumentManagerStore
                .getState()
                .updateDocument(pageId, { saveTimeout: undefined });
            }

            if (outcome.kind === 'conflict') {
              useDocumentManagerStore.getState().setConflict(pageId, outcome.conflict);
              toast.error(
                'Document was modified elsewhere. Your unsaved changes are still here — choose which version to keep.',
                { id: `conflict-${pageId}` }
              );
            } else {
              toast.error(outcome.message, { id: `conflict-${pageId}` });
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
  const conflict = useDocumentManagerStore(
    useCallback((state) => state.conflicts.get(pageId), [pageId])
  );
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

  const hasPendingConflict = useCallback(
    () => useDocumentManagerStore.getState().conflicts.has(pageId),
    [pageId]
  );

  const saveWithDebounce = useCallback(
    (content: string, delay = 1000) => {
      const document = useDocumentManagerStore.getState().documents.get(pageId);
      if (document?.saveTimeout) {
        clearTimeout(document.saveTimeout);
      }

      // A parked conflict means our revision is known-stale: another PATCH
      // would 409 again and the debounce would keep re-firing.
      if (!canScheduleSave({ hasPendingConflict: hasPendingConflict() })) return;

      const timeout = setTimeout(() => {
        // Re-check: a conflict can be detected during the debounce window.
        if (!canScheduleSave({ hasPendingConflict: hasPendingConflict() })) return;
        saving.saveDocument(content).catch(console.error);
      }, delay);

      useDocumentManagerStore.getState().updateDocument(pageId, { saveTimeout: timeout });
    },
    [pageId, saving, hasPendingConflict]
  );

  const forceSave = useCallback(async () => {
    const document = useDocumentManagerStore.getState().documents.get(pageId);
    if (!document?.isDirty) return false;

    if (document.saveTimeout) {
      clearTimeout(document.saveTimeout);
    }

    if (!canScheduleSave({ hasPendingConflict: hasPendingConflict() })) return false;

    return saving.saveDocument(document.content);
  }, [pageId, saving, hasPendingConflict]);

  /**
   * Apply the user's choice from the conflict banner.
   *
   * `keep-mine` re-saves the local text against the revision we observed, so it
   * cannot 409 on the same conflict; if a THIRD party has saved since, the
   * retry 409s again and `saveDocument` re-parks a fresh conflict with the newer
   * remote content — the local text is still never replaced.
   *
   * `use-theirs` adopts the server copy locally; no PATCH is needed because the
   * server already holds it.
   */
  const resolveConflict = useCallback(
    async (choice: ConflictResolutionChoice) => {
      const state = useDocumentManagerStore.getState();
      const conflict = state.conflicts.get(pageId);
      if (!conflict) return false;

      const localContent = state.documents.get(pageId)?.content ?? '';
      const plan = planConflictResolution(choice, { localContent, conflict });

      if (plan.action === 'adopt-remote') {
        const now = Date.now();
        state.updateDocument(pageId, {
          content: plan.contentToAdopt,
          revision: plan.revision,
          isDirty: false,
          lastSaved: now,
          lastUpdateTime: now,
        });
        useDirtyStore.getState().clearDirty(pageId);
        useDocumentManagerStore.getState().clearConflict(pageId);
        return true;
      }

      // Clear first so the save is not blocked by its own conflict guard;
      // a repeat 409 parks a fresh one.
      state.clearConflict(pageId);
      const saved = await saving
        .saveDocument(plan.contentToSave, { expectedRevision: plan.expectedRevision })
        .catch(() => false);

      return saved;
    },
    [pageId, saving]
  );

  return {
    document: documentState.document,
    isLoading,
    isSaving: saving.isSaving,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
    conflict,
    resolveConflict,
    clearDocument: documentState.clearDocument,
  };
};
