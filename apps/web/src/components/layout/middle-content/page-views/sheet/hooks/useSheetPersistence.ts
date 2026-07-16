import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { parseSheetContent, sanitizeSheetData, type SheetData } from '@pagespace/lib/sheets/sheet';
import { useDocument } from '@/hooks/useDocument';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { PageEventPayload } from '@/lib/websocket';
import { shouldApplyServerContent } from '../core/sync';

/**
 * Shell hook bundling the sheet's persistence lifecycle: the pageId-only
 * `useDocument`, the isDirty/content/forceSave refs, initial activation, history
 * reset on server reload, the socket content-update handler (which ignores
 * server content while dirty via the pure `shouldApplyServerContent`), and the
 * auto-save on unmount/blur. The unmount/blur listeners deliberately have empty
 * deps and read through refs so they never re-subscribe or capture stale state.
 */
export interface UseSheetPersistenceParams {
  pageId: string;
  socket: Socket | null;
  /** Reset the undo/redo history to a freshly loaded sheet. */
  resetHistory: (sheet: SheetData) => void;
}

export const useSheetPersistence = ({ pageId, socket, resetHistory }: UseSheetPersistenceParams) => {
  const {
    document: documentState,
    initializeAndActivate,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
  } = useDocument(pageId);

  // Keep forceSave/isDirty/content in refs so the empty-dep listeners below never
  // re-subscribe and always see the latest values.
  const forceSaveRef = useRef(forceSave);
  useEffect(() => {
    forceSaveRef.current = forceSave;
  }, [forceSave]);

  const isDirtyRef = useRef(false);
  const contentRef = useRef(documentState?.content ?? '');
  useEffect(() => {
    isDirtyRef.current = documentState?.isDirty || false;
    contentRef.current = documentState?.content ?? '';
  }, [documentState?.isDirty, documentState?.content]);

  // Initialize/activate the document when the page changes.
  useEffect(() => {
    initializeAndActivate();
  }, [initializeAndActivate, pageId]);

  // Reset history whenever content is (re)loaded from the server so undo cannot
  // walk back into stale state.
  useEffect(() => {
    if (documentState) {
      resetHistory(sanitizeSheetData(parseSheetContent(documentState.content)));
    }
  }, [documentState, resetHistory]);

  // Socket updates — uses refs to avoid re-subscribing on every content change.
  useEffect(() => {
    if (!socket) return;

    const handleContentUpdate = async (eventData: PageEventPayload) => {
      if (eventData.pageId !== pageId) return;
      try {
        const response = await fetchWithAuth(`/api/pages/${pageId}`);
        if (!response.ok) return;
        const updatedPage = await response.json();
        if (shouldApplyServerContent(updatedPage.content, contentRef.current, isDirtyRef.current)) {
          updateContentFromServer(updatedPage.content, updatedPage.revision);
        }
      } catch (error) {
        console.error('Failed to fetch updated sheet content:', error);
      }
    };

    socket.on('page:content-updated', handleContentUpdate);
    return () => {
      socket.off('page:content-updated', handleContentUpdate);
    };
  }, [pageId, socket, updateContentFromServer]);

  // Auto-save any unsaved changes on true unmount.
  useEffect(() => {
    return () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };
  }, []); // ✅ Empty deps — only runs on mount/unmount

  // Auto-save on window blur.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;

    const handleBlur = () => {
      if (isDirtyRef.current) {
        forceSaveRef.current().catch(console.error);
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('blur', handleBlur);
      }
    };
  }, []); // ✅ Empty deps — uses refs for latest state

  // A stable force-save callback for keyboard shortcuts (reads the latest ref).
  // forceSave is async — surface rejections like the unmount/blur savers do.
  const forceSaveNow = useCallback(() => {
    forceSaveRef.current().catch(console.error);
  }, []);

  return {
    documentState,
    updateContent,
    updateContentFromServer,
    saveWithDebounce,
    forceSave,
    forceSaveNow,
  };
};
