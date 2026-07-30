/**
 * The page's conversation resolution, now session-aware: resolution carries
 * `{conversationId, sessionId}` because the Chat tab renders a session-bound
 * thread as a pane grid and a plain one as the plain chat. What matters most:
 * the CAPABILITY SPLIT (session users spawn, everyone else creates plain) and
 * the FALLBACK (a refused spawn degrades to a plain conversation — the page
 * must never fail to open over a workspace it merely could not have).
 */
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

const mockPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
  fetchWithAuth: vi.fn(),
}));

import { useResolvedConversation, createPageConversation } from '../useResolvedConversation';

const OPTS = { driveId: 'drive-1', canUseSessions: false };
const SESSION_OPTS = { driveId: 'drive-1', canUseSessions: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useResolvedConversation', () => {
  it('resolves to the most recent conversation, carrying its session', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({
      id: 'conv-recent',
      sessionId: 'ses-1',
    });

    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));

    await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-recent'));
    expect(result.current.resolved?.sessionId).toBe('ses-1');
    expect(agentConversations.createAgentConversation).not.toHaveBeenCalled();
  });

  it('a pre-session conversation resolves with sessionId null', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({ id: 'conv-old' });

    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));

    await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-old'));
    expect(result.current.resolved?.sessionId).toBeNull();
  });

  it('without the session capability, mints a PLAIN conversation when the agent has none', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);

    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
    expect(result.current.resolved?.sessionId).toBeNull();
    expect(agentConversations.createAgentConversation).toHaveBeenCalledWith(
      'agent-1',
      result.current.resolved?.conversationId,
    );
    // No spawn attempt at all — a session owns a sandbox; a user without the
    // surface must still be able to chat, without a refused request per visit.
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('with the session capability, a fresh conversation is born WITH a session', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-new' });

    const { result } = renderHook(() => useResolvedConversation('agent-1', SESSION_OPTS));

    await waitFor(() => expect(result.current.resolved?.sessionId).toBe('ses-new'));
    expect(result.current.resolved?.conversationId).toBe('conv-new');
    expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions', {
      driveId: 'drive-1',
      agentPageId: 'agent-1',
    });
    expect(agentConversations.createAgentConversation).not.toHaveBeenCalled();
  });

  it('a REFUSED spawn falls back to a plain conversation', async () => {
    // The role gate is a client-side approximation; the server's decision
    // (drive membership + code-execution) is the truth, and "no" means "no
    // workspace", never "no conversation".
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    mockPost.mockRejectedValue(new Error('403'));

    const { result } = renderHook(() => useResolvedConversation('agent-1', SESSION_OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
    expect(result.current.resolved?.sessionId).toBeNull();
    expect(agentConversations.createAgentConversation).toHaveBeenCalled();
  });

  it('reports isLoading true until resolution settles', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({ id: 'conv-recent' });
    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('falls back to minting when the lookup itself fails', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
  });

  it('still selects a local id when even the plain create fails — with the failure surfaced elsewhere', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    agentConversations.createAgentConversation.mockRejectedValue(new Error('down'));

    const { result } = renderHook(() => useResolvedConversation('agent-1', OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
    expect(result.current.resolved?.sessionId).toBeNull();
  });
});

describe('createPageConversation', () => {
  it('is the ONE creation path the page shares between resolution, New Chat and delete-replacement', async () => {
    mockPost.mockResolvedValue({ session: { sessionId: 'ses-x' }, conversationId: 'conv-x' });
    const created = await createPageConversation({
      agentId: 'agent-1',
      driveId: 'drive-1',
      canUseSessions: true,
    });
    expect(created).toEqual({ conversationId: 'conv-x', sessionId: 'ses-x' });
  });
});
