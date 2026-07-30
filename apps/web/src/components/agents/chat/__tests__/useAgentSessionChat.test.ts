/**
 * useAgentSessionChat Hook Tests — Phase 6.
 *
 * The ONE chat's state for a fixed agent + fixed conversation (no dual-mode
 * selector, no pendingPrompt — those are pane-picker concerns, not this
 * hook's). Consumed by `SessionChat.tsx`, one chat pane inside an agent
 * session's pane grid. Behavior under test:
 *
 * - loads the conversation into the shared cache keyed by (agentId, conversationId)
 * - sends { chatId: agentId, conversationId, ...agent config } through useChat
 * - stop is wired
 * - renders from the shared conversation cache
 * - error cause is forwarded
 *
 * renderHook, auth-fetch mocked, real swr, real conversation-messages store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { AgentInfo } from '@/types/agent';

const { mockFetchWithAuth } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

const chat = vi.hoisted(() => ({
  capturedConfigs: [] as Array<Record<string, unknown>>,
  instance: {
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    setMessages: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
    addToolResult: vi.fn(),
  },
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn((config: Record<string, unknown> | undefined) => {
    if (config && typeof config.id === 'string') chat.capturedConfigs.push(config);
    return {
      messages: [] as UIMessage[],
      status: 'ready' as const,
      error: undefined,
      ...chat.instance,
    };
  }),
}));

const loaders = vi.hoisted(() => ({
  loadAgentConversationMessages: vi.fn(async () => {}),
  loadOlderAgentConversationMessages: vi.fn(async () => {}),
}));
vi.mock('@/hooks/conversationMessagesLoaders', () => loaders);

const multiplayer = vi.hoisted(() => ({
  calls: [] as Array<{ selectedAgent: { id: string } | null; agentConversationId: string | null }>,
  rejoin: vi.fn(),
}));
vi.mock('@/hooks/useAgentChannelMultiplayer', () => ({
  useAgentChannelMultiplayer: vi.fn(
    (opts: { selectedAgent: { id: string } | null; agentConversationId: string | null }) => {
      multiplayer.calls.push({
        selectedAgent: opts.selectedAgent,
        agentConversationId: opts.agentConversationId,
      });
      return { rejoinActiveStreams: multiplayer.rejoin };
    },
  ),
}));

vi.mock('@/hooks/useActiveStream', () => ({
  useActiveStream: () => ({ streams: [] }),
  useConversationActiveStream: () => undefined,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/drive-1/agents',
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User', email: 'test@example.com' } }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useAgentSessionChat } from '../useAgentSessionChat';

function agentFixture(id: string): AgentInfo {
  return {
    id,
    title: `Agent ${id}`,
    driveId: 'drive-1',
    driveName: 'Drive One',
    aiProvider: 'anthropic',
    aiModel: 'claude-sonnet-5',
    systemPrompt: 'You are a page agent.',
    enabledTools: ['search'],
  };
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] } as UIMessage;
}

function ids(slug: string) {
  return { agent: agentFixture(`agent-${slug}`), conversationId: `conv-${slug}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  chat.capturedConfigs.length = 0;
  multiplayer.calls.length = 0;
  useConversationMessagesStore.setState({ byConversationId: {} });
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('useAgentSessionChat', () => {
  it('loads the conversation into the shared cache keyed by (agentId, conversationId) on mount', async () => {
    const { agent, conversationId } = ids('load');

    renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await waitFor(() =>
      expect(loaders.loadAgentConversationMessages).toHaveBeenCalledWith(agent.id, conversationId),
    );
    expect(
      multiplayer.calls.some(
        (c) => c.selectedAgent?.id === agent.id && c.agentConversationId === conversationId,
      ),
    ).toBe(true);
  });

  it('uses a stable per-conversation useChat id', () => {
    const { agent, conversationId } = ids('chat-id');

    renderHook(() => useAgentSessionChat({ agent, conversationId }));

    expect(chat.capturedConfigs.some((c) => c.id === `agent-session-chat:${conversationId}`)).toBe(
      true,
    );
  });

  it('sends { chatId: agentId, conversationId, ...agent config } — no session-binding field', async () => {
    const { agent, conversationId } = ids('send');
    conversationMessagesActions.seedConversation(conversationId);

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await act(async () => {
      await result.current.handleSend('hello agent');
    });

    await waitFor(() => expect(chat.instance.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = chat.instance.sendMessage.mock.calls[0] as [
      UIMessage,
      { body?: Record<string, unknown> },
    ];
    expect(message.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'hello agent' })]),
    );
    expect(options.body).toEqual(
      expect.objectContaining({
        chatId: agent.id,
        conversationId,
        provider: agent.aiProvider,
        model: agent.aiModel,
        systemPrompt: agent.systemPrompt,
        enabledTools: agent.enabledTools,
      }),
    );
    expect(options.body).not.toHaveProperty('sessionId');
    expect(options.body).not.toHaveProperty('machineId');
  });

  it('does not send on empty/whitespace-only text', async () => {
    const { agent, conversationId } = ids('empty-send');

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    const dispatched = await act(async () => result.current.handleSend('   '));

    expect(dispatched).toBe(false);
    expect(chat.instance.sendMessage).not.toHaveBeenCalled();
  });

  it('handleStop stops the chat instance', async () => {
    const { agent, conversationId } = ids('stop');

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await act(async () => {
      await result.current.handleStop();
    });

    expect(chat.instance.stop).toHaveBeenCalled();
  });

  it('renders messages from the shared conversation cache', async () => {
    const { agent, conversationId } = ids('render-cache');
    const generation = conversationMessagesActions.startLoad(conversationId);
    conversationMessagesActions.applyLoad(conversationId, generation, [
      assistantMessage('m-cache-1', 'From the cache.'),
    ]);

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m-cache-1']));
  });

  it('reloadConversation re-fetches under (agentId, conversationId)', async () => {
    const { agent, conversationId } = ids('reload');
    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    loaders.loadAgentConversationMessages.mockClear();
    await act(async () => {
      await result.current.reloadConversation();
    });

    expect(loaders.loadAgentConversationMessages).toHaveBeenCalledWith(agent.id, conversationId);
  });

  it('handleScrollNearTop fetches the older page under (agentId, conversationId)', async () => {
    const { agent, conversationId } = ids('older');
    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    act(() => {
      result.current.handleScrollNearTop();
    });

    await waitFor(() =>
      expect(loaders.loadOlderAgentConversationMessages).toHaveBeenCalledWith(agent.id, conversationId),
    );
  });
});
