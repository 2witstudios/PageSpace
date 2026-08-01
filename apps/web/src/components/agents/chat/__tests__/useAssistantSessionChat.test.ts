/**
 * useAssistantSessionChat Hook Tests.
 *
 * Behavior under test: which `contextRef` a send carries. The Agents console
 * never navigates as sessions/panes are clicked, and `agents` isn't even a
 * route `buildContextRef` recognizes as drive-scoped (see `tab-title.ts`) —
 * so the pathname can never tell this hook which drive a DRIVE-SCOPED
 * session's Global Assistant conversation belongs to. The session's own
 * `driveId` (known statically by whoever mounts this hook) must win over
 * pathname parsing whenever the session has one; pathname parsing remains
 * the only signal for a driveless global-assistant session, which has none.
 *
 * renderHook, auth-fetch mocked, real swr, real conversation-messages store —
 * same minimal-mock strategy as `useAgentSessionChat.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { UIMessage } from 'ai';

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
  loadGlobalConversationMessages: vi.fn(async () => {}),
  loadOlderGlobalConversationMessages: vi.fn(async () => {}),
}));
vi.mock('@/hooks/conversationMessagesLoaders', () => loaders);

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
}));

const route = vi.hoisted(() => ({ pathname: '/dashboard/agents' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User', email: 'test@example.com' } }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Real `useGlobalChatConversation` throws outside a `GlobalChatProvider` —
// this hook doesn't mount one, only reads the rejoin callback off it.
vi.mock('@/contexts/GlobalChatContext', () => ({
  useGlobalChatConversation: () => ({ rejoinGlobalStream: vi.fn() }),
}));

import { useDriveStore, type Drive } from '@/hooks/useDrive';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useAssistantSessionChat } from '../useAssistantSessionChat';

function ids(slug: string) {
  return { conversationId: `conv-${slug}` };
}

function driveFixture(id: string, name: string): Drive {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    ownerId: 'user-1',
    isTrashed: false,
    trashedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isOwned: true,
  };
}

function sentBody() {
  const [, options] = chat.instance.sendMessage.mock.calls.at(-1) as [
    UIMessage,
    { body?: Record<string, unknown> },
  ];
  return options.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  chat.capturedConfigs.length = 0;
  route.pathname = '/dashboard/agents';
  activeStream.remoteStreams = [];
  useConversationMessagesStore.setState({ byConversationId: {} });
  useDriveStore.setState({ drives: [driveFixture('drive-1', 'Engineering')] });
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('useAssistantSessionChat — contextRef', () => {
  it("sends routeType 'drive' with the SESSION's own driveId when the session has one, ignoring the pathname entirely", async () => {
    const { conversationId } = ids('drive-scoped');
    conversationMessagesActions.seedConversation(conversationId);
    // The global console route — buildContextRef alone would resolve this to
    // routeType 'other' (agents isn't a route it recognizes at all).
    route.pathname = '/dashboard/agents';

    const { result } = renderHook(() => useAssistantSessionChat({ conversationId, driveId: 'drive-1' }));
    await act(async () => {
      await result.current.handleSend('hello');
    });

    await waitFor(() => expect(chat.instance.sendMessage).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual(
      expect.objectContaining({ contextRef: { routeType: 'drive', driveId: 'drive-1' } }),
    );
  });

  it('still uses the session driveId even while standing on an UNRELATED page in a different drive', async () => {
    const { conversationId } = ids('drive-scoped-elsewhere');
    conversationMessagesActions.seedConversation(conversationId);
    useDriveStore.setState({
      drives: [driveFixture('drive-1', 'Engineering'), driveFixture('drive-2', 'Design')],
    });
    // Main view is showing a page in drive-2; this pane's session is drive-1's.
    route.pathname = '/dashboard/drive-2/some-page';

    const { result } = renderHook(() => useAssistantSessionChat({ conversationId, driveId: 'drive-1' }));
    await act(async () => {
      await result.current.handleSend('put this here');
    });

    await waitFor(() => expect(chat.instance.sendMessage).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual(
      expect.objectContaining({ contextRef: { routeType: 'drive', driveId: 'drive-1' } }),
    );
  });

  it('falls back to the pathname-derived context for a DRIVELESS global-assistant session', async () => {
    const { conversationId } = ids('driveless');
    conversationMessagesActions.seedConversation(conversationId);
    route.pathname = '/dashboard/drive-1/page-1';

    const { result } = renderHook(() => useAssistantSessionChat({ conversationId, driveId: null }));
    await act(async () => {
      await result.current.handleSend('hello');
    });

    await waitFor(() => expect(chat.instance.sendMessage).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual(
      expect.objectContaining({
        contextRef: { routeType: 'page', pageId: 'page-1', driveId: 'drive-1' },
      }),
    );
  });
});

describe('useAssistantSessionChat — ask_user answering', () => {
  // The bug this covers: SessionChat (the global assistant in a session pane, agentPageId
  // null) never wired useAnswerAskUser/AskUserAnswerProvider in, so an ask_user card there
  // was permanently non-interactive regardless of the tool part's own state.
  it('given a pending ask_user on the last assistant message, marks it answerable and submitting it re-invokes the chat via addToolResult', async () => {
    const { conversationId } = ids('ask-user');
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

    const { result } = renderHook(() => useAssistantSessionChat({ conversationId, driveId: null }));

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
    const { conversationId } = ids('ask-user-remote-stream');
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
        pageId: 'global',
        conversationId,
        triggeredBy: { userId: 'other-user', displayName: 'Other User' },
        parts: [],
        isOwn: false,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const { result } = renderHook(() => useAssistantSessionChat({ conversationId, driveId: null }));

    expect(result.current.askUserAnswering.answerableToolCallIds.has('tc-1')).toBe(false);
  });
});
