import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';

// Mock external dependencies before imports
const mockFetchWithAuth = vi.fn();
const mockPatch = vi.fn();
const mockDel = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  patch: (...args: unknown[]) => mockPatch(...args),
  del: (...args: unknown[]) => mockDel(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useMessageActions } from '../useMessageActions';
import { toast } from 'sonner';

function makeMessage(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return {
    id,
    role,
    content: text,
    parts: [{ type: 'text' as const, text }],
    createdAt: new Date(),
  };
}

describe('useMessageActions', () => {
  let setMessages: ReturnType<typeof vi.fn>;
  let regenerate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setMessages = vi.fn();
    regenerate = vi.fn();
    mockPatch.mockResolvedValue(undefined);
    mockDel.mockResolvedValue(undefined);
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
  });

  describe('lastAssistantMessageId / lastUserMessageId', () => {
    it('given messages with roles, should return the last assistant and user message IDs', () => {
      const messages = [
        makeMessage('u1', 'user', 'Hello'),
        makeMessage('a1', 'assistant', 'Hi'),
        makeMessage('u2', 'user', 'How are you?'),
        makeMessage('a2', 'assistant', 'Fine'),
      ];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      expect(result.current.lastAssistantMessageId).toBe('a2');
      expect(result.current.lastUserMessageId).toBe('u2');
    });

    it('given no messages, should return undefined for both', () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages: [],
          setMessages,
          regenerate,
        })
      );

      expect(result.current.lastAssistantMessageId).toBeUndefined();
      expect(result.current.lastUserMessageId).toBeUndefined();
    });
  });

  describe('handleEdit', () => {
    it('given no conversationId, should do nothing', async () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: null,
          messages: [makeMessage('m1', 'user', 'Hello')],
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleEdit('m1', 'Updated');
      });

      expect(setMessages).not.toHaveBeenCalled();
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('given messageId not found, should do nothing', async () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages: [makeMessage('m1', 'user', 'Hello')],
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleEdit('nonexistent', 'Updated');
      });

      expect(setMessages).not.toHaveBeenCalled();
    });

    it('given agent mode, should PATCH via agent endpoint', async () => {
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleEdit('m1', 'Updated text');
      });

      expect(mockPatch).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1/messages/m1',
        { content: 'Updated text' }
      );
    });

    it('given global mode, should PATCH via global endpoint', async () => {
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleEdit('m1', 'Updated text');
      });

      expect(mockPatch).toHaveBeenCalledWith(
        '/api/ai/global/conv-1/messages/m1',
        { content: 'Updated text' }
      );
    });

    it('should apply optimistic update before patch', async () => {
      const messages = [makeMessage('m1', 'user', 'Original')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleEdit('m1', 'Updated');
      });

      // First call is the optimistic update (a functional updater)
      expect(setMessages).toHaveBeenCalled();
      const firstCall = setMessages.mock.calls[0][0];
      expect(typeof firstCall).toBe('function');

      // Execute the updater to verify it maps the text
      const updated = firstCall(messages);
      expect(updated[0].parts[0].text).toBe('Updated');
    });

    it('given successful edit, should call onEditVersionChange and show success toast', async () => {
      const onEditVersionChange = vi.fn();
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
          onEditVersionChange,
        })
      );

      await act(async () => {
        await result.current.handleEdit('m1', 'Updated');
      });

      expect(onEditVersionChange).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Message updated successfully');
    });

    it('given patch throws, should roll back optimistic update and re-throw', async () => {
      const patchError = new Error('patch failed');
      mockPatch.mockRejectedValue(patchError);
      const messages = [makeMessage('m1', 'user', 'Original')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await expect(
        act(async () => {
          await result.current.handleEdit('m1', 'Updated');
        })
      ).rejects.toThrow('patch failed');

      expect(toast.error).toHaveBeenCalledWith(
        'Failed to save edit. Your local changes may not persist.'
      );

      // The rollback updater should have been called
      // Call 0 = optimistic, Call 1 = rollback
      expect(setMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
      const rollback = setMessages.mock.calls[1][0];
      expect(typeof rollback).toBe('function');

      // The rollback should restore the original message
      const rolledBack = rollback(messages);
      expect(rolledBack[0].parts[0].text).toBe('Original');
    });
  });

  describe('handleDelete', () => {
    it('given no conversationId, should do nothing', async () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: null,
          messages: [makeMessage('m1', 'user', 'Hello')],
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('m1');
      });

      expect(setMessages).not.toHaveBeenCalled();
    });

    it('given messageId not found, should do nothing', async () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages: [makeMessage('m1', 'user', 'Hello')],
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('nonexistent');
      });

      expect(setMessages).not.toHaveBeenCalled();
    });

    it('given agent mode, should DELETE via agent endpoint', async () => {
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('m1');
      });

      expect(mockDel).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1/messages/m1'
      );
    });

    it('given global mode, should DELETE via global endpoint', async () => {
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('m1');
      });

      expect(mockDel).toHaveBeenCalledWith(
        '/api/ai/global/conv-1/messages/m1'
      );
    });

    it('should apply optimistic removal before deleting', async () => {
      const messages = [
        makeMessage('m1', 'user', 'Hello'),
        makeMessage('m2', 'assistant', 'Hi'),
      ];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('m1');
      });

      // First call is the optimistic removal
      const optimistic = setMessages.mock.calls[0][0];
      expect(typeof optimistic).toBe('function');
      const filtered = optimistic(messages);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('m2');
    });

    it('given successful delete, should show success toast', async () => {
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleDelete('m1');
      });

      expect(toast.success).toHaveBeenCalledWith('Message deleted');
    });

    it('given delete fails, should roll back and re-throw', async () => {
      mockDel.mockRejectedValue(new Error('delete failed'));
      const messages = [
        makeMessage('m1', 'user', 'Hello'),
        makeMessage('m2', 'assistant', 'Hi'),
      ];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await expect(
        act(async () => {
          await result.current.handleDelete('m1');
        })
      ).rejects.toThrow('delete failed');

      expect(toast.error).toHaveBeenCalledWith('Failed to delete message');

      // Rollback function should re-insert deleted message
      const rollback = setMessages.mock.calls[1][0];
      expect(typeof rollback).toBe('function');

      // If message is already gone, rollback should re-insert it
      const afterRemoval = [makeMessage('m2', 'assistant', 'Hi')];
      const restored = rollback(afterRemoval);
      expect(restored).toHaveLength(2);
      expect(restored[0].id).toBe('m1');
    });

    it('given rollback when message already re-added, should not duplicate', async () => {
      mockDel.mockRejectedValue(new Error('delete failed'));
      const messages = [makeMessage('m1', 'user', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await expect(
        act(async () => {
          await result.current.handleDelete('m1');
        })
      ).rejects.toThrow('delete failed');

      const rollback = setMessages.mock.calls[1][0];
      // If message is already present, should return as-is
      const withMessage = [makeMessage('m1', 'user', 'Hello')];
      const result2 = rollback(withMessage);
      expect(result2).toHaveLength(1);
      expect(result2).toBe(withMessage);
    });
  });

  describe('handleRetry', () => {
    it('given no conversationId, should do nothing', async () => {
      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: null,
          messages: [],
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleRetry();
      });

      expect(regenerate).not.toHaveBeenCalled();
    });

    it('given no user messages, should still regenerate', async () => {
      const messages = [makeMessage('a1', 'assistant', 'Hello')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleRetry();
      });

      expect(regenerate).toHaveBeenCalled();
    });

    it('given messages with assistant after user, should delete old assistant messages then regenerate', async () => {
      const messages = [
        makeMessage('u1', 'user', 'Question'),
        makeMessage('a1', 'assistant', 'Answer 1'),
        makeMessage('a2', 'assistant', 'Answer 2'),
      ];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: null,
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleRetry();
      });

      // Should have deleted both assistant messages
      expect(mockDel).toHaveBeenCalledTimes(2);
      expect(mockDel).toHaveBeenCalledWith('/api/ai/global/conv-1/messages/a1');
      expect(mockDel).toHaveBeenCalledWith('/api/ai/global/conv-1/messages/a2');

      // Should have updated messages to remove deleted ones
      expect(setMessages).toHaveBeenCalled();

      // Should regenerate in global mode (no body)
      expect(regenerate).toHaveBeenCalledWith({ body: undefined });
    });

    it('given agent mode, should regenerate with chatId and conversationId in body', async () => {
      const messages = [makeMessage('u1', 'user', 'Question')];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleRetry();
      });

      expect(regenerate).toHaveBeenCalledWith({
        body: { chatId: 'agent-1', conversationId: 'conv-1' },
      });
    });

    it('given agent mode, should delete via agent endpoint', async () => {
      const messages = [
        makeMessage('u1', 'user', 'Question'),
        makeMessage('a1', 'assistant', 'Answer'),
      ];

      const { result } = renderHook(() =>
        useMessageActions({
          agentId: 'agent-1',
          conversationId: 'conv-1',
          messages,
          setMessages,
          regenerate,
        })
      );

      await act(async () => {
        await result.current.handleRetry();
      });

      expect(mockDel).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1/messages/a1'
      );
    });
  });
});
