/**
 * useEditingStore Tests
 * Tests for global editing state management and session tracking
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  useEditingStore,
  isEditingActive,
  shouldDeferAuthRefresh,
  getEditingDebugInfo,
} from '../useEditingStore';

describe('useEditingStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useEditingStore.setState({ activeSessions: new Map() });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have no active sessions', () => {
      const { activeSessions } = useEditingStore.getState();
      expect(activeSessions.size).toBe(0);
    });

    it('given store is created, isAnyActive should return false', () => {
      const { isAnyActive } = useEditingStore.getState();
      expect(isAnyActive()).toBe(false);
    });

    it('given store is created, isAnyEditing should return false', () => {
      const { isAnyEditing } = useEditingStore.getState();
      expect(isAnyEditing()).toBe(false);
    });

    it('given store is created, isAnyStreaming should return false', () => {
      const { isAnyStreaming } = useEditingStore.getState();
      expect(isAnyStreaming()).toBe(false);
    });
  });

  describe('startEditing', () => {
    it('given a document ID, should create an editing session', () => {
      const { startEditing, getActiveSessions } = useEditingStore.getState();

      startEditing('doc-123');

      const sessions = getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('doc-123');
      expect(sessions[0].type).toBe('document');
    });

    it('given a custom type, should use that type for the session', () => {
      const { startEditing, getActiveSessions } = useEditingStore.getState();

      startEditing('form-456', 'form');

      const sessions = getActiveSessions();
      expect(sessions[0].type).toBe('form');
    });

    it('given metadata, should store it with the session', () => {
      const { startEditing, getActiveSessions } = useEditingStore.getState();
      const metadata = { pageId: 'page-1', componentName: 'DocumentView' };

      startEditing('doc-123', 'document', metadata);

      const sessions = getActiveSessions();
      expect(sessions[0].metadata).toEqual(metadata);
    });

    it('given editing started, should track startedAt timestamp', () => {
      const now = Date.now();
      const { startEditing, getActiveSessions } = useEditingStore.getState();

      startEditing('doc-123');

      const sessions = getActiveSessions();
      expect(sessions[0].startedAt).toBeGreaterThanOrEqual(now);
    });

    it('given multiple sessions started, should track all of them', () => {
      const { startEditing, getSessionCount } = useEditingStore.getState();

      startEditing('doc-1');
      startEditing('doc-2');
      startEditing('doc-3');

      expect(getSessionCount()).toBe(3);
    });
  });

  describe('endEditing', () => {
    it('given an active session, should remove it', () => {
      const { startEditing, endEditing, getSessionCount } = useEditingStore.getState();

      startEditing('doc-123');
      expect(getSessionCount()).toBe(1);

      endEditing('doc-123');

      expect(getSessionCount()).toBe(0);
    });

    it('given a non-existent session ID, should not throw', () => {
      const { endEditing } = useEditingStore.getState();

      expect(() => endEditing('non-existent')).not.toThrow();
    });

    it('given multiple sessions, should only remove the specified one', () => {
      const { startEditing, endEditing, getActiveSessions } = useEditingStore.getState();

      startEditing('doc-1');
      startEditing('doc-2');
      startEditing('doc-3');

      endEditing('doc-2');

      const sessions = getActiveSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain('doc-1');
      expect(sessions.map(s => s.id)).toContain('doc-3');
      expect(sessions.map(s => s.id)).not.toContain('doc-2');
    });
  });

  describe('startStreaming / endStreaming', () => {
    it('given streaming started, should create an ai-streaming session', () => {
      const { startStreaming, getActiveSessions } = useEditingStore.getState();

      startStreaming('chat-123');

      const sessions = getActiveSessions();
      expect(sessions[0].type).toBe('ai-streaming');
    });

    it('given streaming with metadata, should store conversationId', () => {
      const { startStreaming, getActiveSessions } = useEditingStore.getState();

      startStreaming('chat-123', { conversationId: 'conv-456' });

      const sessions = getActiveSessions();
      expect(sessions[0].metadata?.conversationId).toBe('conv-456');
    });

    it('given endStreaming called, should remove the streaming session', () => {
      const { startStreaming, endStreaming, getSessionCount } = useEditingStore.getState();

      startStreaming('chat-123');
      expect(getSessionCount()).toBe(1);

      endStreaming('chat-123');

      expect(getSessionCount()).toBe(0);
    });
  });

  describe('isAnyEditing', () => {
    it('given document session active, should return true', () => {
      const { startEditing, isAnyEditing } = useEditingStore.getState();

      startEditing('doc-123', 'document');

      expect(isAnyEditing()).toBe(true);
    });

    it('given form session active, should return true', () => {
      const { startEditing, isAnyEditing } = useEditingStore.getState();

      startEditing('form-123', 'form');

      expect(isAnyEditing()).toBe(true);
    });

    it('given only streaming session active, should return false', () => {
      const { startStreaming, isAnyEditing } = useEditingStore.getState();

      startStreaming('chat-123');

      expect(isAnyEditing()).toBe(false);
    });
  });

  describe('isAnyStreaming', () => {
    it('given streaming session active, should return true', () => {
      const { startStreaming, isAnyStreaming } = useEditingStore.getState();

      startStreaming('chat-123');

      expect(isAnyStreaming()).toBe(true);
    });

    it('given only document session active, should return false', () => {
      const { startEditing, isAnyStreaming } = useEditingStore.getState();

      startEditing('doc-123', 'document');

      expect(isAnyStreaming()).toBe(false);
    });
  });

  describe('isAnyActive', () => {
    it('given document session active, should return true', () => {
      const { startEditing, isAnyActive } = useEditingStore.getState();

      startEditing('doc-123');

      expect(isAnyActive()).toBe(true);
    });

    it('given streaming session active, should return true', () => {
      const { startStreaming, isAnyActive } = useEditingStore.getState();

      startStreaming('chat-123');

      expect(isAnyActive()).toBe(true);
    });

    it('given no sessions, should return false', () => {
      const { isAnyActive } = useEditingStore.getState();

      expect(isAnyActive()).toBe(false);
    });
  });

  describe('clearAllSessions', () => {
    it('given multiple sessions, should remove all of them', () => {
      const { startEditing, startStreaming, clearAllSessions, getSessionCount } = useEditingStore.getState();

      startEditing('doc-1');
      startEditing('doc-2');
      startStreaming('chat-1');

      expect(getSessionCount()).toBe(3);

      clearAllSessions();

      expect(getSessionCount()).toBe(0);
    });
  });

  describe('helper functions', () => {
    describe('isEditingActive', () => {
      it('given active session, should return true', () => {
        const { startEditing } = useEditingStore.getState();

        startEditing('doc-123');

        expect(isEditingActive()).toBe(true);
      });

      it('given no sessions, should return false', () => {
        expect(isEditingActive()).toBe(false);
      });
    });

    describe('shouldDeferAuthRefresh', () => {
      it('given active session, should return true', () => {
        const { startEditing } = useEditingStore.getState();

        startEditing('doc-123');

        expect(shouldDeferAuthRefresh()).toBe(true);
      });

      it('given no sessions, should return false', () => {
        expect(shouldDeferAuthRefresh()).toBe(false);
      });
    });

    describe('getEditingDebugInfo', () => {
      it('given sessions active, should return detailed debug info', () => {
        const { startEditing, startStreaming } = useEditingStore.getState();

        startEditing('doc-123', 'document', { pageId: 'page-1' });
        startStreaming('chat-456', { conversationId: 'conv-1' });

        const debugInfo = getEditingDebugInfo();

        expect(debugInfo.sessionCount).toBe(2);
        expect(debugInfo.isAnyEditing).toBe(true);
        expect(debugInfo.isAnyStreaming).toBe(true);
        expect(debugInfo.sessions).toHaveLength(2);
        expect(debugInfo.sessions[0].duration).toBeGreaterThanOrEqual(0);
      });

      it('given no sessions, should return empty debug info', () => {
        const debugInfo = getEditingDebugInfo();

        expect(debugInfo.sessionCount).toBe(0);
        expect(debugInfo.isAnyEditing).toBe(false);
        expect(debugInfo.isAnyStreaming).toBe(false);
        expect(debugInfo.sessions).toHaveLength(0);
      });
    });
  });

  describe('pending sends', () => {
    beforeEach(() => {
      // Reset pending sends before each test
      useEditingStore.setState({ pendingSends: new Set() });
    });

    describe('startPendingSend', () => {
      it('given a conversation ID, should add it to pendingSends', () => {
        const { startPendingSend, hasPendingSend } = useEditingStore.getState();

        startPendingSend('conv-123');

        expect(hasPendingSend('conv-123')).toBe(true);
      });

      it('given multiple conversation IDs, should track all of them', () => {
        const { startPendingSend, hasPendingSend } = useEditingStore.getState();

        startPendingSend('conv-1');
        startPendingSend('conv-2');
        startPendingSend('conv-3');

        expect(hasPendingSend('conv-1')).toBe(true);
        expect(hasPendingSend('conv-2')).toBe(true);
        expect(hasPendingSend('conv-3')).toBe(true);
      });

      it('given same ID added twice, should only have one entry', () => {
        const { startPendingSend } = useEditingStore.getState();

        startPendingSend('conv-123');
        startPendingSend('conv-123');

        const { pendingSends } = useEditingStore.getState();
        expect(pendingSends.size).toBe(1);
      });
    });

    describe('endPendingSend', () => {
      it('given a tracked conversation ID, should remove it', () => {
        const { startPendingSend, endPendingSend, hasPendingSend } = useEditingStore.getState();

        startPendingSend('conv-123');
        expect(hasPendingSend('conv-123')).toBe(true);

        endPendingSend('conv-123');

        expect(hasPendingSend('conv-123')).toBe(false);
      });

      it('given a non-existent conversation ID, should not throw', () => {
        const { endPendingSend } = useEditingStore.getState();

        expect(() => endPendingSend('non-existent')).not.toThrow();
      });

      it('given multiple pending sends, should only remove the specified one', () => {
        const { startPendingSend, endPendingSend, hasPendingSend } = useEditingStore.getState();

        startPendingSend('conv-1');
        startPendingSend('conv-2');
        startPendingSend('conv-3');

        endPendingSend('conv-2');

        expect(hasPendingSend('conv-1')).toBe(true);
        expect(hasPendingSend('conv-2')).toBe(false);
        expect(hasPendingSend('conv-3')).toBe(true);
      });
    });

    describe('hasPendingSend', () => {
      it('given conversation ID in pending sends, should return true', () => {
        const { startPendingSend, hasPendingSend } = useEditingStore.getState();

        startPendingSend('conv-123');

        expect(hasPendingSend('conv-123')).toBe(true);
      });

      it('given conversation ID not in pending sends, should return false', () => {
        const { hasPendingSend } = useEditingStore.getState();

        expect(hasPendingSend('non-existent')).toBe(false);
      });
    });

    describe('isAnyActive with pending sends', () => {
      it('given pending send active, should return true', () => {
        const { startPendingSend, isAnyActive } = useEditingStore.getState();

        startPendingSend('conv-123');

        expect(isAnyActive()).toBe(true);
      });

      it('given both sessions and pending sends, should return true', () => {
        const { startEditing, startPendingSend, isAnyActive } = useEditingStore.getState();

        startEditing('doc-123');
        startPendingSend('conv-456');

        expect(isAnyActive()).toBe(true);
      });

      it('given pending send ended but session active, should return true', () => {
        const { startEditing, startPendingSend, endPendingSend, isAnyActive } = useEditingStore.getState();

        startEditing('doc-123');
        startPendingSend('conv-456');
        endPendingSend('conv-456');

        expect(isAnyActive()).toBe(true);
      });

      it('given session ended but pending send active, should return true', () => {
        const { startEditing, endEditing, startPendingSend, isAnyActive } = useEditingStore.getState();

        startEditing('doc-123');
        startPendingSend('conv-456');
        endEditing('doc-123');

        expect(isAnyActive()).toBe(true);
      });
    });

    describe('isEditingActive with pending sends', () => {
      it('given only pending send active, should return true', () => {
        const { startPendingSend } = useEditingStore.getState();

        startPendingSend('conv-123');

        expect(isEditingActive()).toBe(true);
      });
    });
  });
});
