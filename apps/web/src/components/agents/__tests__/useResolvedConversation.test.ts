/**
 * The page's conversation resolution, now session-aware: resolution carries
 * `{conversationId, sessionId}` because the Chat tab renders a session-bound
 * thread as a pane grid and a plain one as the plain chat. What matters most:
 * the CAPABILITY SPLIT (session users spawn, everyone else creates plain), the
 * FALLBACK (a refused spawn degrades to a plain conversation — the page must
 * never fail to open over a workspace it merely could not have), the
 * AUTH-LOADING GATE (a hard refresh must never mint a permanently
 * session-less first conversation while the role is still unknown), and the
 * QUOTA-vs-CAPABILITY split in how a refusal is surfaced.
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
const { MockApiRequestError } = vi.hoisted(() => ({
  MockApiRequestError: class MockApiRequestError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
    }
  },
}));
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => mockPost(...args),
  fetchWithAuth: vi.fn(),
  ApiRequestError: MockApiRequestError,
}));

const mockToastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: mockToastError } }));

import { useResolvedConversation, createPageConversation } from '../useResolvedConversation';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const OPTS = { driveId: 'drive-1', canUseSessions: false, authLoading: false };
const SESSION_OPTS = { driveId: 'drive-1', canUseSessions: true, authLoading: false };

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

  it('a CAPABILITY refusal (403) falls back silently — no toast', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    mockPost.mockRejectedValue(new ApiRequestError('Insufficient permissions to use this agent', 403));

    const { result } = renderHook(() => useResolvedConversation('agent-1', SESSION_OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
    expect(result.current.resolved?.sessionId).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('a QUOTA refusal (429) surfaces distinctly from the silent capability degrade', async () => {
    // The caller HAS the capability and simply ran out of allowance — worth
    // interrupting them for, unlike every other refusal.
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    mockPost.mockRejectedValue(
      new ApiRequestError('You have 100 active sessions — end some before starting more.', 429),
    );

    const { result } = renderHook(() => useResolvedConversation('agent-1', SESSION_OPTS));

    await waitFor(() => expect(result.current.resolved).not.toBeNull());
    expect(result.current.resolved?.sessionId).toBeNull();
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(
      'Workspace unavailable — plain chat',
      expect.objectContaining({ description: expect.stringContaining('100 active sessions') }),
    );
  });

  it('while auth is still loading, resolution WAITS — then creates WITH the session capability once it resolves', async () => {
    // Key acceptance case: a hard refresh must never mint an admin's first
    // conversation session-less just because the role hasn't loaded yet.
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue(null);
    mockPost.mockResolvedValue({ session: { sessionId: 'ses-new' }, conversationId: 'conv-new' });

    const { result, rerender } = renderHook(
      ({ authLoading, canUseSessions }: { authLoading: boolean; canUseSessions: boolean }) =>
        useResolvedConversation('agent-1', { driveId: 'drive-1', canUseSessions, authLoading }),
      { initialProps: { authLoading: true, canUseSessions: false } },
    );

    expect(result.current.isLoading).toBe(true);
    expect(agentConversations.fetchMostRecentAgentConversation).not.toHaveBeenCalled();

    // Auth settles: the caller now knows the admin role.
    rerender({ authLoading: false, canUseSessions: true });

    await waitFor(() => expect(result.current.resolved?.sessionId).toBe('ses-new'));
    expect(result.current.resolved?.conversationId).toBe('conv-new');
    expect(agentConversations.createAgentConversation).not.toHaveBeenCalled();
  });

  it('a later authLoading blip does not re-resolve an already-settled agent', async () => {
    agentConversations.fetchMostRecentAgentConversation.mockResolvedValue({
      id: 'conv-recent',
      sessionId: 'ses-1',
    });

    const { result, rerender } = renderHook(
      ({ authLoading }: { authLoading: boolean }) =>
        useResolvedConversation('agent-1', { ...OPTS, authLoading }),
      { initialProps: { authLoading: false } },
    );

    await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-recent'));
    expect(agentConversations.fetchMostRecentAgentConversation).toHaveBeenCalledTimes(1);

    // A token-refresh-shaped loading blip, for the SAME agent, must not
    // restart resolution and clobber the conversation the user is in.
    rerender({ authLoading: true });
    rerender({ authLoading: false });

    expect(agentConversations.fetchMostRecentAgentConversation).toHaveBeenCalledTimes(1);
    expect(result.current.resolved?.conversationId).toBe('conv-recent');
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

  describe('initialConversationId (deep link from the past-conversations list)', () => {
    it('resolves directly to it, skipping the most-recent lookup entirely', async () => {
      const { result } = renderHook(() =>
        useResolvedConversation('agent-1', {
          ...OPTS,
          initialConversationId: 'conv-deep-link',
          initialSessionId: 'ses-deep-link',
        }),
      );

      await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-deep-link'));
      expect(result.current.resolved?.sessionId).toBe('ses-deep-link');
      expect(agentConversations.fetchMostRecentAgentConversation).not.toHaveBeenCalled();
      expect(agentConversations.createAgentConversation).not.toHaveBeenCalled();
    });

    it('defaults sessionId to null when none is given', async () => {
      const { result } = renderHook(() =>
        useResolvedConversation('agent-1', { ...OPTS, initialConversationId: 'conv-deep-link' }),
      );

      await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-deep-link'));
      expect(result.current.resolved?.sessionId).toBeNull();
    });

    it('still waits for auth to settle before resolving, same as the ordinary path', async () => {
      const { result, rerender } = renderHook(
        ({ authLoading }: { authLoading: boolean }) =>
          useResolvedConversation('agent-1', { ...OPTS, authLoading, initialConversationId: 'conv-deep-link' }),
        { initialProps: { authLoading: true } },
      );

      expect(result.current.isLoading).toBe(true);
      rerender({ authLoading: false });

      await waitFor(() => expect(result.current.resolved?.conversationId).toBe('conv-deep-link'));
    });
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

  describe('given a sessionId to reuse (issue #2263, finding 4)', () => {
    // Deleting the CURRENT conversation must mint its replacement INTO the
    // same session — never spawn a new one, which would abandon a live
    // session (contradicting "a session is never empty") and leave the old
    // session's quota burned for nothing.
    it('mints the replacement into that session via the session-scoped route, never /api/agent-sessions', async () => {
      mockPost.mockResolvedValue(undefined);
      const created = await createPageConversation({
        agentId: 'agent-1',
        driveId: 'drive-1',
        canUseSessions: true,
        sessionId: 'ses-existing',
      });

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe('/api/ai/page-agents/agent-1/conversations');
      expect(body).toMatchObject({ sessionId: 'ses-existing' });
      expect(created.sessionId).toBe('ses-existing');
      expect(created.conversationId).toBe(body.conversationId);
    });

    it('takes priority over canUseSessions — reuse is never downgraded to a fresh spawn', async () => {
      mockPost.mockResolvedValue(undefined);
      await createPageConversation({
        agentId: 'agent-1',
        driveId: 'drive-1',
        canUseSessions: false,
        sessionId: 'ses-existing',
      });

      expect(mockPost).toHaveBeenCalledWith(
        '/api/ai/page-agents/agent-1/conversations',
        expect.objectContaining({ sessionId: 'ses-existing' }),
      );
    });
  });
});
