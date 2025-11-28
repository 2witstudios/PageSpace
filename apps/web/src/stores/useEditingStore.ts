/**
 * Global Editing State Store
 *
 * Tracks active editing and streaming sessions to prevent interruptions
 * from auth refreshes, SWR revalidations, and other background updates.
 *
 * This is a pure state-based solution (no refs) that integrates with:
 * - Document editing (DocumentView)
 * - AI streaming (AiChatView, GlobalAssistantView, SidebarChatTab)
 * - Auth refresh protection (auth-store)
 * - SWR isPaused() conditions (UsageCounter, UserDropdown)
 */

import { create } from 'zustand';

export type SessionType = 'document' | 'ai-streaming' | 'form' | 'other';

export interface EditingSession {
  id: string;
  type: SessionType;
  startedAt: number;
  metadata?: {
    pageId?: string;
    conversationId?: string;
    componentName?: string;
  };
}

interface EditingState {
  // Active sessions map
  activeSessions: Map<string, EditingSession>;

  // Query methods
  isAnyEditing: () => boolean;
  isAnyStreaming: () => boolean;
  isAnyActive: () => boolean;
  getActiveSessions: () => EditingSession[];
  getSessionCount: () => number;

  // Session management
  startEditing: (id: string, type?: SessionType, metadata?: EditingSession['metadata']) => void;
  endEditing: (id: string) => void;
  startStreaming: (id: string, metadata?: EditingSession['metadata']) => void;
  endStreaming: (id: string) => void;

  // Cleanup
  clearAllSessions: () => void;
}

export const useEditingStore = create<EditingState>((set, get) => ({
  // Initial state
  activeSessions: new Map(),

  // Query methods
  isAnyEditing: () => {
    const sessions = Array.from(get().activeSessions.values());
    return sessions.some(s => s.type === 'document' || s.type === 'form');
  },

  isAnyStreaming: () => {
    const sessions = Array.from(get().activeSessions.values());
    return sessions.some(s => s.type === 'ai-streaming');
  },

  isAnyActive: () => {
    return get().activeSessions.size > 0;
  },

  getActiveSessions: () => {
    return Array.from(get().activeSessions.values());
  },

  getSessionCount: () => {
    return get().activeSessions.size;
  },

  // Session management
  startEditing: (id, type = 'document', metadata) => {
    set((state) => {
      const newSessions = new Map(state.activeSessions);
      newSessions.set(id, {
        id,
        type,
        startedAt: Date.now(),
        metadata,
      });

      if (process.env.NODE_ENV === 'development') {
        console.log(`[EDITING] Started: ${id} (type: ${type}, active: ${newSessions.size})`);
      }

      return { activeSessions: newSessions };
    });
  },

  endEditing: (id) => {
    set((state) => {
      const newSessions = new Map(state.activeSessions);
      const session = newSessions.get(id);

      if (session) {
        newSessions.delete(id);

        if (process.env.NODE_ENV === 'development') {
          const duration = Date.now() - session.startedAt;
          console.log(`[EDITING] Ended: ${id} (duration: ${duration}ms, active: ${newSessions.size})`);
        }
      }

      return { activeSessions: newSessions };
    });
  },

  startStreaming: (id, metadata) => {
    get().startEditing(id, 'ai-streaming', metadata);
  },

  endStreaming: (id) => {
    get().endEditing(id);
  },

  clearAllSessions: () => {
    if (process.env.NODE_ENV === 'development') {
      console.log('[EDITING] Clearing all sessions');
    }
    set({ activeSessions: new Map() });
  },
}));

/**
 * Helper to check if any editing/streaming is active
 * Useful for SWR isPaused() and other conditional logic
 */
export const isEditingActive = () => useEditingStore.getState().isAnyActive();

/**
 * Helper to check if should defer auth refresh
 * Used by auth-store to prevent interruptions
 */
export const shouldDeferAuthRefresh = () => useEditingStore.getState().isAnyActive();

/**
 * Get detailed info about active sessions (for debugging)
 */
export const getEditingDebugInfo = () => {
  const state = useEditingStore.getState();
  return {
    sessionCount: state.getSessionCount(),
    isAnyEditing: state.isAnyEditing(),
    isAnyStreaming: state.isAnyStreaming(),
    sessions: state.getActiveSessions().map(s => ({
      id: s.id,
      type: s.type,
      duration: Date.now() - s.startedAt,
      metadata: s.metadata,
    })),
  };
};
