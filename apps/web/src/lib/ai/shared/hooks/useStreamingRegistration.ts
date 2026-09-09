import { useEffect } from 'react';
import { useEditingStore, type EditingSession } from '@/stores/useEditingStore';

/**
 * Registers/unregisters streaming state with the editing store.
 * Registers an editing-store session of type `'ai-streaming'` for the duration of a stream.
 *
 * WHAT THAT ACTUALLY GATES, enumerated because a vaguer claim here ("prevents SWR
 * revalidation and other UI refreshes") was inherited and repeated as justification
 * elsewhere, and was wrong:
 *
 *   - SWR revalidation: NO. Every `isPaused()` call site asks `isAnyEditing()`, which
 *     deliberately matches only `'document' | 'form'`.
 *   - Auth-token refresh: NO. `shouldDeferAuthRefresh` (= `isAnyActive`) has no callers.
 *   - The global quick-create shortcut: YES. `QuickCreatePalette` gates its key binding on
 *     `!isEditingActive()`, which IS `isAnyActive` and counts every session type — so a
 *     live stream disables it app-wide, and a STRANDED entry disables it permanently.
 *   - The conversation's own UI: YES, and this is the load-bearing one. `displayIsStreaming`
 *     and `isConversationBusy` derive from the same store entries, so the composer shows
 *     Stop instead of Send and `ask_user` is unanswerable while a stream is live.
 *
 * Cleans up on unmount.
 */
export function useStreamingRegistration(
  id: string,
  isStreaming: boolean,
  metadata?: EditingSession['metadata']
): void {
  useEffect(() => {
    if (isStreaming) {
      useEditingStore.getState().startStreaming(id, metadata);
    } else {
      useEditingStore.getState().endStreaming(id);
    }
    return () => {
      useEditingStore.getState().endStreaming(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- individual metadata fields avoid re-running on object identity changes
  }, [id, isStreaming, metadata?.pageId, metadata?.conversationId, metadata?.componentName]);
}
