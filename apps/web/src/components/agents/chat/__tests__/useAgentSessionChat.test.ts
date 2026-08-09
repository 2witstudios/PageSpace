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
import type { ChatOnFinishCallback, UIMessage } from 'ai';
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
  // Mutable per-test override for useChat's own live return — distinct from
  // the shared conversation cache, so a test can simulate a stream that is
  // in-flight in useChat's local state but not yet (or never) mirrored into
  // usePendingStreamsStore/the rendered cache.
  state: {
    messages: [] as UIMessage[],
    status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
  },
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn((config: Record<string, unknown> | undefined) => {
    if (config && typeof config.id === 'string') chat.capturedConfigs.push(config);
    return {
      messages: chat.state.messages,
      status: chat.state.status,
      error: undefined,
      ...chat.instance,
    };
  }),
}));

const loaders = vi.hoisted(() => ({
  loadAgentConversationMessages: vi.fn(async () => {}),
  loadOlderAgentConversationMessages: vi.fn(async () => {}),
  refreshConversationSnapshot: vi.fn(async () => {}),
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

const activeStream = vi.hoisted(() => ({
  remoteStreams: [] as Array<{
    messageId: string;
    pageId: string;
    conversationId: string;
    triggeredBy: { userId: string; displayName: string };
    parts: unknown[];
    isOwn: boolean;
    startedAt?: string;
  }>,
}));
vi.mock('@/hooks/useActiveStream', () => ({
  useActiveStream: () => ({ streams: activeStream.remoteStreams }),
  useConversationActiveStream: () => undefined,
  getActiveStreamById: () => undefined,
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
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
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
  chat.state.messages = [];
  chat.state.status = 'ready';
  multiplayer.calls.length = 0;
  activeStream.remoteStreams = [];
  useConversationMessagesStore.setState({ byConversationId: {} });
  usePendingStreamsStore.setState({ streams: new Map() });
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

    expect(chat.capturedConfigs.some((c) => c.id === `agent-session-chat:${agent.id}:${conversationId}`)).toBe(
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

  // The bug this covers: SessionChat (agent pages + every pane in AgentPanes) never wired
  // useAnswerAskUser/AskUserAnswerProvider in, so an ask_user card rendered there was
  // permanently non-interactive regardless of the tool part's own state.
  it('given a pending ask_user on the last assistant message, marks it answerable and submitting it re-invokes the chat via addToolResult', async () => {
    const { agent, conversationId } = ids('ask-user');
    const generation = conversationMessagesActions.startLoad(conversationId);
    conversationMessagesActions.applyLoad(conversationId, generation, [
      {
        id: 'm-ask-1',
        role: 'assistant',
        parts: [
          { type: 'tool-ask_user', toolCallId: 'tc-1', state: 'input-available', input: { questions: [] } },
        ],
      } as unknown as UIMessage,
    ]);

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await waitFor(() =>
      expect(result.current.askUserAnswering.answerableToolCallIds.has('tc-1')).toBe(true),
    );

    await act(async () => {
      result.current.askUserAnswering.submitAnswers('tc-1', { answers: [] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(chat.instance.addToolResult).toHaveBeenCalledTimes(1));
    const [callArgs] = chat.instance.addToolResult.mock.calls[0] as [{ toolCallId: string; tool: string }];
    expect(callArgs.toolCallId).toBe('tc-1');
    expect(callArgs.tool).toBe('ask_user');
  });

  // Codex review, PR #2303 (P1): displayIsStreaming is own-stream-only (what Stop is
  // scoped to). A REMOTE collaborator's stream leaves it false while renderedMessages
  // filters their in-flight message out, so a stale ask_user prompt from before their
  // run started would otherwise stay answerable — submitting it invokes addToolResult,
  // whose server-side takeover aborts the collaborator's still-running generation.
  it('given a remote collaborator is streaming in this conversation, does not mark a stale ask_user answerable', async () => {
    const { agent, conversationId } = ids('ask-user-remote-stream');
    const generation = conversationMessagesActions.startLoad(conversationId);
    conversationMessagesActions.applyLoad(conversationId, generation, [
      {
        id: 'm-ask-1',
        role: 'assistant',
        parts: [
          { type: 'tool-ask_user', toolCallId: 'tc-1', state: 'input-available', input: { questions: [] } },
        ],
      } as unknown as UIMessage,
    ]);
    activeStream.remoteStreams = [
      {
        messageId: 'm-remote-1',
        pageId: agent.id,
        conversationId,
        triggeredBy: { userId: 'other-user', displayName: 'Other User' },
        parts: [],
        isOwn: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    expect(result.current.askUserAnswering.answerableToolCallIds.has('tc-1')).toBe(false);
  });

  // Regression: the sender's own pane went blank mid-stream while other viewers saw the reply
  // stream in fine. useOwnStreamMirror's `ownMessages` must be useChat's OWN live-growing
  // `messages` array (its doc comment: "This chat's ENTIRE message array (useChat's local
  // state) — not a pre-picked message") so it can copy the in-flight assistant reply into
  // usePendingStreamsStore — the store every pane actually renders from. Feeding it the
  // rendered/cache-derived array instead (what shadowed a `messages` binding of the same name
  // here) leaves that store empty for the sender, so their own pane shows nothing until a later
  // reload. This test mounts the hook with useChat mid-stream (status: 'streaming', an assistant
  // reply as the last message) and asserts the mirror actually wrote that message into the store.
  it('mirrors an in-progress own-stream assistant reply into usePendingStreamsStore, from useChat\'s own live messages', async () => {
    const { agent, conversationId } = ids('own-stream-mirror');
    chat.state.status = 'streaming';
    chat.state.messages = [
      { id: 'm-user-1', role: 'user', parts: [{ type: 'text', text: 'hello agent' }] } as UIMessage,
      {
        id: 'm-assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Partial reply in progress...' }],
      } as UIMessage,
    ];

    renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await waitFor(() => {
      const entry = usePendingStreamsStore.getState().streams.get('m-assistant-1');
      expect(entry).toBeDefined();
      expect(entry?.isOwn).toBe(true);
      expect(entry?.pageId).toBe(agent.id);
      expect(entry?.conversationId).toBe(conversationId);
    });
  });

  // Sibling of the mirror regression above, for the COMPLETION edge: the sender's own tab
  // never joins its SSE multicast, so at chat:stream_complete its stream entry is already
  // removed and the socket handler can only fall back to a full reload — a visible flash,
  // and a vanished reply if that reload fails. The chatConfig's onFinish must commit the
  // finished reply locally so neither the broadcast nor the reload is load-bearing.
  it('given the own stream finishes, commits the reply into the cache via the chatConfig onFinish', async () => {
    const { agent, conversationId } = ids('own-finish-commit');
    conversationMessagesActions.addOptimisticSend(conversationId, {
      id: 'm-user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'the question' }],
    } as UIMessage);

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    const config = chat.capturedConfigs.at(-1)!;
    expect(typeof config.onFinish).toBe('function');
    const onFinish = config.onFinish as ChatOnFinishCallback<UIMessage>;

    const reply = assistantMessage('m-assistant-1', 'the full reply');
    act(() => {
      onFinish({ message: reply, messages: [reply], isAbort: false, isDisconnect: false, isError: false });
    });

    expect(usePendingStreamsStore.getState().streams.size).toBe(0);
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['m-user-1', 'm-assistant-1']);
    });
    expect(loaders.refreshConversationSnapshot).toHaveBeenCalledWith(agent.id, conversationId);
  });
});
