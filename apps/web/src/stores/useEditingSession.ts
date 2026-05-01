import { useEffect } from 'react';
import { useEditingStore, type EditingSession, type SessionType } from './useEditingStore';

/**
 * Register an editing-store session while `active` is true.
 * Cleans up on unmount or when `active` flips to false.
 */
export function useEditingSession(
  sessionId: string,
  active: boolean,
  type: SessionType = 'form',
  metadata?: EditingSession['metadata'],
) {
  const componentName = metadata?.componentName;
  const pageId = metadata?.pageId;
  const conversationId = metadata?.conversationId;
  useEffect(() => {
    if (!active) return;
    useEditingStore
      .getState()
      .startEditing(sessionId, type, { componentName, pageId, conversationId });
    return () => useEditingStore.getState().endEditing(sessionId);
  }, [active, sessionId, type, componentName, pageId, conversationId]);
}
