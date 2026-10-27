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
  readContent,
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
    async (
      content: string,
      options?: { expectedRevision?: number; resolvingConflict?: boolean }
    ) => {
      // Deepest guard: while a conflict is parked the stored revision is
      // known-stale, so ONLY the resolution path may write. This is an explicit
      // per-call opt-in rather than a temporary clear of the shared conflict
      // state — clearing it early would open the debounce/forceSave guards for
      // the whole duration of the awaited retry, letting a keystroke fire a
      // second PATCH with the stale revision and park a phantom conflict for a
      // save that actually succeeded.
      if (
        !options?.resolvingConflict &&
        !canScheduleSave({
          hasPendingConflict: useDocumentManagerStore.getState().conflicts.has(pageId),
        })
      ) {
        return false;
      }

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
  // Store-level, so every view mounting this page shares one resolution state.
  const isResolvingConflict = useDocumentManagerStore(
    useCallback((state) => state.resolvingConflicts.has(pageId), [pageId])
  );

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
      if (!canScheduleSave({ hasPendingConflict: hasPendingConflict() })) {
        // Drop the handle we just cleared so the store does not advertise a
        // pending save that no longer exists. Only on this path — the normal
        // one overwrites it below, and a second write per keystroke would
        // re-render every subscriber for nothing.
        if (document?.saveTimeout) {
          useDocumentManagerStore.getState().updateDocument(pageId, { saveTimeout: undefined });
        }
        return;
      }

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

      // Serialize: a page can be open in more than one view, each rendering its
      // own banner. Without this, two clicks send two PATCHes with the same
      // expectedRevision — the server takes one and 409s the other, parking a
      // spurious conflict on the conflict that was just resolved.
      if (state.resolvingConflicts.has(pageId)) return false;

      // Mirror of the remote-side guard in decideConflictOutcome: "no local
      // record" must never become "save an empty document over their work".
      const local = readContent(state.documents.get(pageId)?.content);
      if (!local.present) {
        toast.error(
          'Your local copy of this document is no longer loaded, so it cannot be compared. Reopen the page to see the current version.',
          { id: `conflict-${pageId}` }
        );
        return false;
      }

      const plan = planConflictResolution(choice, { localContent: local.content, conflict });

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
        state.clearConflict(pageId);
        return true;
      }

      // The conflict stays PARKED for the whole retry, so the autosave guards
      // stay closed and a keystroke mid-flight cannot race this PATCH. It is
      // cleared only once the retry has actually succeeded; a repeat 409 leaves
      // the fresher snapshot `saveDocument` just parked in its place, and any
      // other failure leaves the banner up so the user can try again.
      state.setResolvingConflict(pageId, true);
      try {
        const saved = await saving
          .saveDocument(plan.contentToSave, {
            expectedRevision: plan.expectedRevision,
            resolvingConflict: true,
          })
          .catch(() => false);

        if (saved) {
          useDocumentManagerStore.getState().clearConflict(pageId);

          // Edits made DURING the retry were blocked by the (correctly closed)
          // autosave guard, so nothing is scheduled for them. Without this they
          // sit unsaved until the next keystroke, blur or manual save.
          const afterSave = useDocumentManagerStore.getState().documents.get(pageId);
          if (afterSave?.isDirty) {
            saveWithDebounce(afterSave.content);
          }
        }

        return saved;
      } finally {
        useDocumentManagerStore.getState().setResolvingConflict(pageId, false);
      }
    },
    [pageId, saving, saveWithDebounce]
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
    isResolvingConflict,
    clearDocument: documentState.clearDocument,
  };
};
