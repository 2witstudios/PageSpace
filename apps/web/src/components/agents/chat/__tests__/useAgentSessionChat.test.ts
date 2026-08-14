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
    sendMessage: vi.fn(async () => {}),
    regenerate: vi.fn(async () => {}),
    clearError: vi.fn(),
    addToolResult: vi.fn(async () => {}),
  },
  state: {
    status: 'ready' as 'ready' | 'submitted' | 'streaming' | 'error',
  },
}));

vi.mock('@/lib/ai/shared/hooks/useChatSession', () => ({
  useChatSession: vi.fn((config: Record<string, unknown>) => {
    chat.capturedConfigs.push(config);
    return { status: chat.state.status, error: undefined, ...chat.instance };
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

  it('binds the send shell to this agent\'s channel and this conversation', () => {
    // There is no `useChat` id to be stable ANY MORE, and that is the point: a stable id was
    // what made one `Chat` serve every conversation on a surface, which is the constraint that
    // required the cross-conversation handoff. A shell is bound to its endpoint and channel;
    // the conversation is an argument at send time.
    const { agent, conversationId } = ids('chat-id');

    renderHook(() => useAgentSessionChat({ agent, conversationId }));

    expect(chat.capturedConfigs).toContainEqual(
      expect.objectContaining({
        api: '/api/ai/chat',
        channelId: agent.id,
        conversationId,
        triggeredBy: expect.objectContaining({ userId: 'user-1' }),
      }),
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
    const [message, sentConversationId, options] = chat.instance.sendMessage.mock.calls[0] as unknown as [
      UIMessage,
      string,
      { body?: Record<string, unknown> },
    ];
    // The conversation is passed EXPLICITLY at send time rather than latched from surface props
    // — which is what removes the whole class of "the latch named the wrong conversation" bugs.
    expect(sentConversationId).toBe(conversationId);
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

  it('handleStop never cancels locally — there is nothing local to cancel', async () => {
    // INVERTED. This used to assert `chat.instance.stop` was called. Cancelling a local read
    // stops NOTHING server-side: streams are server-owned and survive client disconnect, so all
    // a local stop achieved was ending the run's VISIBLE life while it kept generating, kept
    // calling write tools, and kept billing. The one Stop goes through `useStopStream` to
    // `/api/ai/abort`, which is covered in that hook's own suite; here the assertion is that no
    // local stop exists to be called.
    const { agent, conversationId } = ids('stop');

    const { result } = renderHook(() => useAgentSessionChat({ agent, conversationId }));

    await act(async () => {
      await result.current.handleStop();
    });

    expect(chat.instance).not.toHaveProperty('stop');
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
    const [callArgs] = chat.instance.addToolResult.mock.calls[0] as unknown as [{ toolCallId: string; tool: string }];
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

  // TWO CASES WERE HERE, and both pinned mechanisms that are structurally gone.
  //
  // 'mirrors an in-progress own-stream assistant reply into usePendingStreamsStore, from
  // useChat's own live messages' pinned `useOwnStreamMirror` — the hook that copied this
  // chat's live reply OUT of useChat's internal array and INTO the store, so an own stream
  // was present the same way a bootstrapped or remote one was. `useChatSession` opens the
  // store entry ITSELF, from the admission envelope, keyed by the messageId the server
  // stated. There is nothing to mirror because nothing is duplicated, and the entry exists
  // from the moment the send is admitted rather than from its first token. The end-to-end
  // version of this fact is in `hooks/__tests__/concurrentConversations.integration.test.tsx`,
  // over the real shell, registry and store.
  //
  // 'given the own stream finishes, commits the reply into the cache via the chatConfig
  // onFinish' pinned `buildOwnStreamCommitOnFinish`. It existed because the sender's own tab
  // never joined its own SSE multicast, so at `chat:stream_complete` its store entry was
  // already gone and the socket handler could only fall back to a full reload — a visible
  // flash, and a vanished reply if the reload failed. Neither premise holds: this tab DOES
  // subscribe to its own stream (one registry, one subscription, whoever announces it), and
  // the registry fires its end notification on every terminal path — including the purely
  // local one, the SSE join resolving — while the store entry is STILL PRESENT. The shared
  // commit protocol therefore runs off the same entry it always did, with no callback needed.
  // That ordering is pinned in `streamSessionRegistry.test.ts` and end-to-end in the
  // integration suite.
});
