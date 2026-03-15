import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import {
  fetchAgentConversationMessages,
  fetchAgentConversationMessagesLegacy,
  fetchMostRecentAgentConversation,
  createAgentConversation,
} from '../agent-conversations';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

describe('agent-conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchAgentConversationMessages', () => {
    it('should fetch messages with correct URL', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages: [], pagination: null }),
      } as Response);

      await fetchAgentConversationMessages('agent-1', 'conv-1');

      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1/messages'
      );
    });

    it('should include query params when options provided', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages: [], pagination: null }),
      } as Response);

      await fetchAgentConversationMessages('agent-1', 'conv-1', {
        limit: 20,
        cursor: 'cursor-abc',
        direction: 'before',
      });

      const calledUrl = vi.mocked(fetchWithAuth).mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=20');
      expect(calledUrl).toContain('cursor=cursor-abc');
      expect(calledUrl).toContain('direction=before');
    });

    it('should handle legacy array response format', async () => {
      const mockMessages = [{ id: '1', role: 'user', parts: [] }];
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      } as Response);

      const result = await fetchAgentConversationMessages('agent-1', 'conv-1');
      expect(result.messages).toEqual(mockMessages);
      expect(result.pagination).toBeNull();
    });

    it('should handle new paginated response format', async () => {
      const mockMessages = [{ id: '1', role: 'user', parts: [] }];
      const mockPagination = { hasMore: true, nextCursor: 'next', prevCursor: null, limit: 50, direction: 'before' };
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages: mockMessages, pagination: mockPagination }),
      } as Response);

      const result = await fetchAgentConversationMessages('agent-1', 'conv-1');
      expect(result.messages).toEqual(mockMessages);
      expect(result.pagination).toEqual(mockPagination);
    });

    it('should throw on non-ok response', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(
        fetchAgentConversationMessages('agent-1', 'conv-1')
      ).rejects.toThrow('Failed to load messages');
    });

    it('should default to empty messages when response has no messages', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await fetchAgentConversationMessages('agent-1', 'conv-1');
      expect(result.messages).toEqual([]);
      expect(result.pagination).toBeNull();
    });
  });

  describe('fetchAgentConversationMessagesLegacy', () => {
    it('should return just the messages array', async () => {
      const mockMessages = [{ id: '1', role: 'user', parts: [] }];
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages: mockMessages }),
      } as Response);

      const result = await fetchAgentConversationMessagesLegacy('agent-1', 'conv-1');
      expect(result).toEqual(mockMessages);
    });
  });

  describe('fetchMostRecentAgentConversation', () => {
    it('should return the most recent conversation', async () => {
      const mockConversation = { id: 'conv-1', title: 'Test' };
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ conversations: [mockConversation] }),
      } as Response);

      const result = await fetchMostRecentAgentConversation('agent-1');
      expect(result).toEqual(mockConversation);
    });

    it('should return null when no conversations', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ conversations: [] }),
      } as Response);

      const result = await fetchMostRecentAgentConversation('agent-1');
      expect(result).toBeNull();
    });

    it('should return null when conversations field is missing', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await fetchMostRecentAgentConversation('agent-1');
      expect(result).toBeNull();
    });

    it('should throw on non-ok response', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
      await expect(fetchMostRecentAgentConversation('agent-1')).rejects.toThrow('Failed to load conversations');
    });
  });

  describe('createAgentConversation', () => {
    it('should return conversation ID from conversationId field', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ conversationId: 'new-conv' }),
      } as Response);

      const result = await createAgentConversation('agent-1');
      expect(result).toBe('new-conv');
    });

    it('should return conversation ID from id field', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'new-conv-2' }),
      } as Response);

      const result = await createAgentConversation('agent-1');
      expect(result).toBe('new-conv-2');
    });

    it('should throw when no ID in response', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      await expect(createAgentConversation('agent-1')).rejects.toThrow('Conversation id missing');
    });

    it('should throw on non-ok response', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
      await expect(createAgentConversation('agent-1')).rejects.toThrow('Failed to create conversation');
    });

    it('should send POST request', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ conversationId: 'x' }),
      } as Response);

      await createAgentConversation('agent-1');
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
