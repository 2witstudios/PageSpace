import { useEffect } from 'react';
import { useEditingStore, type EditingSession } from '@/stores/useEditingStore';

/**
 * Registers/unregisters streaming state with the editing store.
 * Prevents SWR revalidation and other UI refreshes during active AI streaming.
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
