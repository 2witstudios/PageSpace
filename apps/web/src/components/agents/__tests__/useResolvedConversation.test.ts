import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const agentConversations = vi.hoisted(() => ({
  fetchMostRecentAgentConversation: vi.fn(),
  createAgentConversation: vi.fn(async () => {}),
}));
vi.mock('@/lib/ai/shared/agent-conversations', () => agentConversations);

vi.mock('@/hooks/conversationMessagesActions', () => ({
  conversationMessagesActions: { seedConversation: vi.fn() },
}));

import { useResolvedConversation } from '../useResolvedConversation';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useResolvedConversation', () => {
  it('resolves to the most recent conversation when one exists', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({ id: 'conv-recent' });

    const { result } = renderHook(() => useResolvedConversation('agent-1'));

    await waitFor(() => expect(result.current.conversationId).toBe('conv-recent'));
    expect(agentConversations.createAgentConversation).not.toHaveBeenCalled();
  });

  it('mints and persists a fresh conversation when the agent has none', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);

    const { result } = renderHook(() => useResolvedConversation('agent-1'));

    await waitFor(() => expect(result.current.conversationId).not.toBeNull());
    await waitFor(() =>
      expect(agentConversations.createAgentConversation).toHaveBeenCalledWith(
        'agent-1',
        result.current.conversationId,
      ),
    );
  });

  it('reports isLoading true until resolution settles', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({ id: 'conv-recent' });
    const { result } = renderHook(() => useResolvedConversation('agent-1'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('falls back to minting when the lookup itself fails', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useResolvedConversation('agent-1'));

    await waitFor(() => expect(result.current.conversationId).not.toBeNull());
  });
});
