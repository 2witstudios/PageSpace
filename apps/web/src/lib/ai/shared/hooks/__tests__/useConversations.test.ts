import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock external dependencies before imports
const mockFetchWithAuth = vi.fn();
const mockMutate = vi.fn();
const mockIsEditingActive = vi.fn(() => false);

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('swr', () => {
  // Track the SWR callback for manual control
  const actualUseSWR = vi.fn((key: string | null, fetcher: unknown, options?: Record<string, unknown>) => {
    // Store the fetcher and key on the mock so tests can introspect
    (actualUseSWR as Record<string, unknown>).__lastKey = key;
    (actualUseSWR as Record<string, unknown>).__lastFetcher = fetcher;
    (actualUseSWR as Record<string, unknown>).__lastOptions = options;
    return {
      data: (actualUseSWR as Record<string, unknown>).__data ?? undefined,
      isLoading: (actualUseSWR as Record<string, unknown>).__isLoading ?? false,
      error: undefined,
    };
  });
  return {
    default: actualUseSWR,
    mutate: (...args: unknown[]) => mockMutate(...args),
  };
});

vi.mock('@/stores/useEditingStore', () => ({
  isEditingActive: () => mockIsEditingActive(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// The source file imports from '../chat-types' relative to the hooks/ directory.
// vi.mock resolves relative to the test file, so we need to go up one more level.
vi.mock('../../chat-types', () => ({
  parseConversationsData: (data: unknown[]) => data,
}));

import { useConversations } from '../useConversations';
import { toast } from 'sonner';
import useSWR from 'swr';

const mockUseSWR = useSWR as unknown as ReturnType<typeof vi.fn> & {
  __data?: unknown;
  __isLoading?: boolean;
};

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.__data = undefined;
    mockUseSWR.__isLoading = false;
  });

  describe('SWR key computation', () => {
    it('given agent mode with agentId, should use the page-agents API endpoint', () => {
      renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
          enabled: true,
        })
      );

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given global mode (null agentId), should use the global API endpoint', () => {
      renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
          enabled: true,
        })
      );

      expect(mockUseSWR).toHaveBeenCalledWith(
        '/api/ai/global',
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('given enabled is false, should pass null as SWR key', () => {
      renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
          enabled: false,
        })
      );

      expect(mockUseSWR).toHaveBeenCalledWith(
        null,
        expect.any(Function),
        expect.any(Object)
      );
    });
  });

  describe('conversations parsing', () => {
    it('given data with conversations array, should parse and return them', () => {
      const rawConversations = [
        { id: 'c1', title: 'Chat 1' },
        { id: 'c2', title: 'Chat 2' },
      ];
      mockUseSWR.__data = { conversations: rawConversations };

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      expect(result.current.conversations).toEqual(rawConversations);
    });

    it('given no data, should return empty conversations array', () => {
      mockUseSWR.__data = undefined;

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      expect(result.current.conversations).toEqual([]);
    });

    it('given data without conversations field, should return empty array', () => {
      mockUseSWR.__data = { other: 'stuff' };

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      expect(result.current.conversations).toEqual([]);
    });
  });

  describe('loadConversation', () => {
    it('given agent mode, should fetch messages from agent endpoint and call onConversationLoad', async () => {
      const onLoad = vi.fn();
      const messages = [{ id: 'm1', role: 'user' }];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages }),
      });

      const { result } = renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
          onConversationLoad: onLoad,
        })
      );

      await act(async () => {
        await result.current.loadConversation('conv-1');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1/messages'
      );
      expect(onLoad).toHaveBeenCalledWith('conv-1', messages);
    });

    it('given global mode, should fetch messages from global endpoint', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      });

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.loadConversation('conv-1');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/global/conv-1/messages'
      );
    });

    it('given fetch fails, should show error toast', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.loadConversation('conv-1');
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to load conversation');
    });

    it('given fetch throws, should show error toast', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.loadConversation('conv-1');
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to load conversation');
    });
  });

  describe('createConversation', () => {
    it('given agent mode, should POST to agent endpoint and return new conversation id', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ conversationId: 'new-conv' }),
      });
      const onCreate = vi.fn();

      const { result } = renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
          onConversationCreate: onCreate,
        })
      );

      let newId: string | null = null;
      await act(async () => {
        newId = await result.current.createConversation();
      });

      expect(newId).toBe('new-conv');
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        })
      );
      expect(onCreate).toHaveBeenCalledWith('new-conv');
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given global mode, should POST to global endpoint with type global', async () => {
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'global-conv' }),
      });

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      let newId: string | null = null;
      await act(async () => {
        newId = await result.current.createConversation();
      });

      expect(newId).toBe('global-conv');
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/global',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ type: 'global' }),
        })
      );
    });

    it('given server returns not ok, should return null', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      let newId: string | null = 'not-null';
      await act(async () => {
        newId = await result.current.createConversation();
      });

      expect(newId).toBeNull();
    });

    it('given fetch throws, should return null and show toast', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      let newId: string | null = 'not-null';
      await act(async () => {
        newId = await result.current.createConversation();
      });

      expect(newId).toBeNull();
      expect(toast.error).toHaveBeenCalledWith('Failed to create new conversation');
    });
  });

  describe('deleteConversation', () => {
    it('given agent mode, should DELETE from agent endpoint', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: true });

      const { result } = renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.deleteConversation('conv-1');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations/conv-1',
        { method: 'DELETE' }
      );
      expect(mockMutate).toHaveBeenCalled();
    });

    it('given global mode, should DELETE from global endpoint', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: true });

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.deleteConversation('conv-1');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/global/conv-1',
        { method: 'DELETE' }
      );
    });

    it('given deleting the current conversation, should call onConversationDelete', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: true });
      const onDelete = vi.fn();

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: 'conv-1',
          onConversationDelete: onDelete,
        })
      );

      await act(async () => {
        await result.current.deleteConversation('conv-1');
      });

      expect(onDelete).toHaveBeenCalledWith('conv-1');
    });

    it('given deleting a different conversation, should NOT call onConversationDelete', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: true });
      const onDelete = vi.fn();

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: 'conv-1',
          onConversationDelete: onDelete,
        })
      );

      await act(async () => {
        await result.current.deleteConversation('conv-other');
      });

      expect(onDelete).not.toHaveBeenCalled();
    });

    it('given delete fails, should show error toast', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      await act(async () => {
        await result.current.deleteConversation('conv-1');
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to delete conversation');
    });
  });

  describe('refreshConversations', () => {
    it('given a valid swrKey, should call mutate', () => {
      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
          enabled: true,
        })
      );

      act(() => {
        result.current.refreshConversations();
      });

      expect(mockMutate).toHaveBeenCalledWith('/api/ai/global');
    });

    it('given disabled (null swrKey), should not call mutate', () => {
      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
          enabled: false,
        })
      );

      act(() => {
        result.current.refreshConversations();
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should expose the swrKey for external invalidation', () => {
      const { result } = renderHook(() =>
        useConversations({
          agentId: 'agent-1',
          currentConversationId: null,
          enabled: true,
        })
      );

      expect(result.current.swrKey).toBe('/api/ai/page-agents/agent-1/conversations');
    });

    it('given isLoading from SWR, should expose isLoading', () => {
      mockUseSWR.__isLoading = true;

      const { result } = renderHook(() =>
        useConversations({
          agentId: null,
          currentConversationId: null,
        })
      );

      expect(result.current.isLoading).toBe(true);
    });
  });
});
