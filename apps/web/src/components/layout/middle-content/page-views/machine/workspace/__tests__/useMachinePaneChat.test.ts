/**
 * useMachinePaneChat Hook Tests — Phase 11 (#2166)
 *
 * The machine pane's dual-mode chat state: null selection = the assistant
 * identity on the machine-anchored conversation (the terminal row's id,
 * chatId = machineId); any page agent = that agent's own chat. Behavior under
 * test (phase page h1jtxfqy280oavmbr1k5v1sz):
 *
 * - mode switch swaps surface id + conversation identity, no cross-mode bleed
 * - return to null RESUMES the machine conversation (row id) — never mints a
 *   new session row
 * - default mode sends { chatId: machineId, conversationId: terminalId };
 *   agent mode sends the agent's own ids
 * - History lists/opens per-mode conversations
 * - a fresh empty default-mode conversation auto-sends pendingPrompt exactly
 *   once, then onPromptSent(); never for a resumed (non-empty) session
 * - Stop is wired in both modes
 *
 * Template: useMachineWorkspaceSync.test.ts (renderHook, auth-fetch mocked,
 * real swr, real conversation-messages store).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { AgentInfo } from '@/types/agent';

// ============================================
// Mocks
// ============================================

const { mockFetchWithAuth } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

// Two controllable useChat instances. useDualModeChat calls useChat twice per
// render, default (global slot) first, agent second — same order every render.
const chat = vi.hoisted(() => {
  const instance = () => ({
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    setMessages: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
    addToolResult: vi.fn(),
  });
  return {
    capturedConfigs: [] as Array<Record<string, unknown>>,
    defaultChat: instance(),
    agentChat: instance(),
    counter: { n: 0 },
  };
});

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn((config: Record<string, unknown> | undefined) => {
    chat.counter.n += 1;
    if (config && typeof config.id === 'string') chat.capturedConfigs.push(config);
    const instance = chat.counter.n % 2 === 1 ? chat.defaultChat : chat.agentChat;
    return {
      messages: [] as UIMessage[],
      status: 'ready' as const,
      error: undefined,
      ...instance,
    };
  }),
}));

// Cache loaders are spied — the tests seed the real conversation-messages
// store directly instead of round-tripping through fetches.
const loaders = vi.hoisted(() => ({
  loadAgentConversationMessages: vi.fn(async () => {}),
  loadOlderAgentConversationMessages: vi.fn(async () => {}),
  loadGlobalConversationMessages: vi.fn(async () => {}),
  loadOlderGlobalConversationMessages: vi.fn(async () => {}),
  refreshConversationSnapshot: vi.fn(async () => {}),
}));
vi.mock('@/hooks/conversationMessagesLoaders', () => loaders);

// Multiplayer wiring is asserted by its inputs, not exercised.
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
  usePathname: () => '/dashboard/drive-1/machine-page',
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User', email: 'test@example.com' } }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useMachinePaneChat } from '../useMachinePaneChat';

// ============================================
// Fixtures
// ============================================

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function conversationRow(id: string, title: string) {
  const now = new Date().toISOString();
  return {
    id,
    title,
    preview: '',
    isShared: false,
    isOwner: true,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    lastMessage: { role: 'user', timestamp: now },
  };
}

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

/** Unique ids per test — SWR's cache is keyed by URL and survives renderHook
 * calls within the file, so a reused machine id would serve a previous test's
 * cached conversation list. */
function ids(slug: string) {
  return { machineId: `machine-${slug}`, terminalId: `terminal-${slug}` };
}

/** fetchWithAuth routing: most-recent lookups (?limit=1) per agent, full
 * conversation lists per page id. Anything unrouted resolves empty. */
function routeFetches(routes: {
  mostRecent?: Record<string, Array<{ id: string }>>;
  lists?: Record<string, Array<ReturnType<typeof conversationRow>>>;
}) {
  mockFetchWithAuth.mockImplementation(async (url: string) => {
    const match = /\/api\/ai\/page-agents\/([^/]+)\/conversations(\?limit=1)?$/.exec(url);
    if (match) {
      const [, pageId, isMostRecent] = match;
      if (isMostRecent) {
        return jsonResponse({ conversations: routes.mostRecent?.[pageId] ?? [] });
      }
      return jsonResponse({ conversations: routes.lists?.[pageId] ?? [] });
    }
    return jsonResponse({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  chat.capturedConfigs.length = 0;
  chat.counter.n = 0;
  multiplayer.calls.length = 0;
  useConversationMessagesStore.setState({ byConversationId: {} });
  routeFetches({});
});

// ============================================
// Default (machine) mode identity
// ============================================

describe('useMachinePaneChat', () => {
  describe('default mode identity', () => {
    it('mounts on the machine-anchored conversation: surface id machine-pane:<terminalId>, conversation = the terminal row id', async () => {
      const { machineId, terminalId } = ids('default-identity');

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      expect(result.current.selectedAgent).toBeNull();
      expect(result.current.currentConversationId).toBe(terminalId);
      expect(
        chat.capturedConfigs.some((c) => c.id === `machine-pane:${terminalId}`),
      ).toBe(true);

      // The machine conversation loads through the AGENT loader keyed by the
      // machine page id — the machine page hosts the conversation row.
      await waitFor(() =>
        expect(loaders.loadAgentConversationMessages).toHaveBeenCalledWith(machineId, terminalId),
      );

      // Multiplayer is wired to the machine's page channel in default mode.
      expect(
        multiplayer.calls.some(
          (c) => c.selectedAgent?.id === machineId && c.agentConversationId === terminalId,
        ),
      ).toBe(true);
    });

    it('sends { chatId: machineId, conversationId: terminalId } through the DEFAULT chat instance', async () => {
      const { machineId, terminalId } = ids('default-send');
      conversationMessagesActions.seedConversation(terminalId);

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      await act(async () => {
        await result.current.handleSend('hello machine');
      });

      await waitFor(() => expect(chat.defaultChat.sendMessage).toHaveBeenCalledTimes(1));
      expect(chat.agentChat.sendMessage).not.toHaveBeenCalled();

      const [message, options] = chat.defaultChat.sendMessage.mock.calls[0] as [
        UIMessage,
        { body?: Record<string, unknown> },
      ];
      expect(message.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'hello machine' })]),
      );
      expect(options.body).toEqual(
        expect.objectContaining({ chatId: machineId, conversationId: terminalId }),
      );
    });
  });

  // ============================================
  // Agent mode + mode switching
  // ============================================

  describe('agent mode and mode switching', () => {
    it('selecting an agent swaps to the agent surface id and the agent\'s own conversation identity', async () => {
      const { machineId, terminalId } = ids('agent-switch');
      const agent = agentFixture('agent-switch-1');
      routeFetches({ mostRecent: { [agent.id]: [{ id: 'conv-agent-recent' }] } });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });

      await waitFor(() => expect(result.current.currentConversationId).toBe('conv-agent-recent'));
      expect(result.current.selectedAgent?.id).toBe(agent.id);
      expect(
        chat.capturedConfigs.some((c) => c.id === `machine-pane-agent:${terminalId}`),
      ).toBe(true);
      await waitFor(() =>
        expect(loaders.loadAgentConversationMessages).toHaveBeenCalledWith(
          agent.id,
          'conv-agent-recent',
        ),
      );
      // Agent-channel multiplayer follows the selection.
      expect(
        multiplayer.calls.some(
          (c) => c.selectedAgent?.id === agent.id && c.agentConversationId === 'conv-agent-recent',
        ),
      ).toBe(true);
    });

    it('agent mode sends the AGENT\'s own ids through the AGENT chat instance — machine ids never bleed in', async () => {
      const { machineId, terminalId } = ids('agent-send');
      const agent = agentFixture('agent-send-1');
      routeFetches({ mostRecent: { [agent.id]: [{ id: 'conv-agent-send' }] } });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });
      await waitFor(() => expect(result.current.currentConversationId).toBe('conv-agent-send'));

      await act(async () => {
        await result.current.handleSend('hello agent');
      });

      await waitFor(() => expect(chat.agentChat.sendMessage).toHaveBeenCalledTimes(1));
      expect(chat.defaultChat.sendMessage).not.toHaveBeenCalled();

      const [, options] = chat.agentChat.sendMessage.mock.calls[0] as [
        UIMessage,
        { body?: Record<string, unknown> },
      ];
      expect(options.body).toEqual(
        expect.objectContaining({ chatId: agent.id, conversationId: 'conv-agent-send' }),
      );
      expect(options.body).not.toEqual(
        expect.objectContaining({ chatId: machineId }),
      );
    });

    it('an agent with no conversations gets a client-minted one, persisted to the AGENT\'s page', async () => {
      const { machineId, terminalId } = ids('agent-create');
      const agent = agentFixture('agent-create-1');
      routeFetches({ mostRecent: { [agent.id]: [] } });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });

      await waitFor(() => {
        expect(result.current.currentConversationId).not.toBeNull();
        expect(result.current.currentConversationId).not.toBe(terminalId);
      });

      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          `/api/ai/page-agents/${agent.id}/conversations`,
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    });

    it('returning to null RESUMES the machine conversation (row id) — never mints a new session row', async () => {
      const { machineId, terminalId } = ids('resume-null');
      const agent = agentFixture('agent-resume-1');
      routeFetches({ mostRecent: { [agent.id]: [{ id: 'conv-agent-resume' }] } });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });
      await waitFor(() => expect(result.current.currentConversationId).toBe('conv-agent-resume'));

      act(() => {
        result.current.selectAgent(null);
      });

      await waitFor(() => expect(result.current.currentConversationId).toBe(terminalId));
      expect(result.current.selectedAgent).toBeNull();

      // Never minted: no conversation row was ever created on the MACHINE page.
      const machineCreates = mockFetchWithAuth.mock.calls.filter(
        ([url, init]: [string, RequestInit | undefined]) =>
          url === `/api/ai/page-agents/${machineId}/conversations` && init?.method === 'POST',
      );
      expect(machineCreates).toHaveLength(0);
    });
  });

  // ============================================
  // History — per-mode conversations
  // ============================================

  describe('history', () => {
    it('default mode lists the MACHINE page\'s conversations', async () => {
      const { machineId, terminalId } = ids('history-default');
      routeFetches({
        lists: { [machineId]: [conversationRow('machine-conv-1', 'Machine chat')] },
      });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      await waitFor(() =>
        expect(result.current.conversations.map((c) => c.id)).toEqual(['machine-conv-1']),
      );
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        `/api/ai/page-agents/${machineId}/conversations`,
      );
    });

    it('agent mode lists the AGENT\'s conversations', async () => {
      const { machineId, terminalId } = ids('history-agent');
      const agent = agentFixture('agent-history-1');
      routeFetches({
        mostRecent: { [agent.id]: [{ id: 'agent-conv-1' }] },
        lists: { [agent.id]: [conversationRow('agent-conv-1', 'Agent chat')] },
      });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });

      await waitFor(() =>
        expect(result.current.conversations.map((c) => c.id)).toEqual(['agent-conv-1']),
      );
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        `/api/ai/page-agents/${agent.id}/conversations`,
      );
    });

    it('opening a history conversation loads it under the ACTIVE mode\'s page id and adopts it', async () => {
      const { machineId, terminalId } = ids('history-open');
      routeFetches({
        lists: { [machineId]: [conversationRow('machine-conv-2', 'Older machine chat')] },
      });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      await act(async () => {
        await result.current.openConversation('machine-conv-2');
      });

      expect(result.current.currentConversationId).toBe('machine-conv-2');
      expect(loaders.loadAgentConversationMessages).toHaveBeenCalledWith(
        machineId,
        'machine-conv-2',
      );
    });
  });

  // ============================================
  // pendingPrompt — auto-send exactly once
  // ============================================

  describe('pendingPrompt', () => {
    it('auto-sends into a fresh EMPTY default-mode conversation exactly once, then onPromptSent()', async () => {
      const { machineId, terminalId } = ids('pending-fresh');
      conversationMessagesActions.seedConversation(terminalId);
      const onPromptSent = vi.fn();

      const { rerender } = renderHook(() =>
        useMachinePaneChat({
          machineId,
          terminalId,
          pendingPrompt: 'run the tests',
          onPromptSent,
        }),
      );

      await waitFor(() => expect(chat.defaultChat.sendMessage).toHaveBeenCalledTimes(1));
      const [message, options] = chat.defaultChat.sendMessage.mock.calls[0] as [
        UIMessage,
        { body?: Record<string, unknown> },
      ];
      expect(message.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'run the tests' })]),
      );
      expect(options.body).toEqual(
        expect.objectContaining({ chatId: machineId, conversationId: terminalId }),
      );
      await waitFor(() => expect(onPromptSent).toHaveBeenCalledTimes(1));

      rerender();
      await act(async () => {});
      expect(chat.defaultChat.sendMessage).toHaveBeenCalledTimes(1);
      expect(onPromptSent).toHaveBeenCalledTimes(1);
    });

    it('never auto-sends into a RESUMED session (conversation already has messages)', async () => {
      const { machineId, terminalId } = ids('pending-resumed');
      const generation = conversationMessagesActions.startLoad(terminalId);
      conversationMessagesActions.applyLoad(terminalId, generation, [
        assistantMessage('m-existing', 'Already ran once.'),
      ]);
      const onPromptSent = vi.fn();

      renderHook(() =>
        useMachinePaneChat({
          machineId,
          terminalId,
          pendingPrompt: 'run the tests',
          onPromptSent,
        }),
      );

      await act(async () => {});
      expect(chat.defaultChat.sendMessage).not.toHaveBeenCalled();
      expect(onPromptSent).not.toHaveBeenCalled();
    });

    it('does not auto-send while the conversation is still unloaded', async () => {
      const { machineId, terminalId } = ids('pending-unloaded');
      // No seed: the cache has no loaded entry for the terminal conversation.
      const onPromptSent = vi.fn();

      renderHook(() =>
        useMachinePaneChat({
          machineId,
          terminalId,
          pendingPrompt: 'run the tests',
          onPromptSent,
        }),
      );

      await act(async () => {});
      expect(chat.defaultChat.sendMessage).not.toHaveBeenCalled();
      expect(onPromptSent).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Stop — wired in both modes
  // ============================================

  describe('stop', () => {
    it('default mode: handleStop stops the DEFAULT chat instance', async () => {
      const { machineId, terminalId } = ids('stop-default');

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      await act(async () => {
        await result.current.handleStop();
      });

      expect(chat.defaultChat.stop).toHaveBeenCalled();
      expect(chat.agentChat.stop).not.toHaveBeenCalled();
    });

    it('agent mode: handleStop stops the AGENT chat instance', async () => {
      const { machineId, terminalId } = ids('stop-agent');
      const agent = agentFixture('agent-stop-1');
      routeFetches({ mostRecent: { [agent.id]: [{ id: 'conv-agent-stop' }] } });

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      act(() => {
        result.current.selectAgent(agent);
      });
      await waitFor(() => expect(result.current.currentConversationId).toBe('conv-agent-stop'));

      await act(async () => {
        await result.current.handleStop();
      });

      expect(chat.agentChat.stop).toHaveBeenCalled();
    });
  });

  // ============================================
  // Rendering source
  // ============================================

  describe('rendered messages', () => {
    it('renders from the shared conversation cache, per conversation', async () => {
      const { machineId, terminalId } = ids('render-cache');
      const generation = conversationMessagesActions.startLoad(terminalId);
      conversationMessagesActions.applyLoad(terminalId, generation, [
        assistantMessage('m-cache-1', 'From the cache.'),
      ]);

      const { result } = renderHook(() => useMachinePaneChat({ machineId, terminalId }));

      await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m-cache-1']));
    });
  });
});
