/**
 * AiChatView.test.tsx mocks `useConversations` wholesale, so its "select from
 * history" tests only prove that AiChatView reacts correctly to a manually
 * simulated onConversationLoad callback — they never exercise the real
 * useConversations.loadConversation implementation. This file re-runs the
 * history-select flow with the REAL useConversations hook (only its network
 * layer, fetchWithAuth, is mocked) to catch bugs the fully-mocked suite can't see.
 */
import { describe, test, vi, beforeEach, type Mock } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from './riteway';

const { mockFetchWithAuth, mockSetMessages } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockSetMessages: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({ driveId: 'test-drive-id' })),
}));

vi.mock('@ai-sdk/react', () => {
  const chatState = {
    messages: [] as unknown[],
    sendMessage: vi.fn(),
    status: 'idle' as const,
    error: undefined as Error | undefined,
    regenerate: vi.fn(),
    setMessages: mockSetMessages,
    stop: vi.fn(),
  };
  return { useChat: vi.fn(() => chatState) };
});

// useConversations's own SWR list-fetch is irrelevant to loadConversation —
// stub useSWR itself out but still provide `mutate` since useConversations
// imports it (unused on this path, but must exist to avoid a crash).
vi.mock('swr', () => {
  const swrCache = { get: vi.fn(() => undefined) };
  return {
    default: vi.fn(() => ({ data: undefined, isLoading: false })),
    mutate: vi.fn(),
    useSWRConfig: vi.fn(() => ({ cache: swrCache })),
  };
});

vi.mock('@/hooks/useDrive', () => {
  const driveState = { drives: [] as unknown[] };
  return {
    useDriveStore: vi.fn((selector: (state: typeof driveState) => unknown) =>
      selector(driveState)
    ),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-1', name: 'Test User' } })),
}));

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: vi.fn((selector: (state: { webSearchEnabled: boolean }) => unknown) =>
    selector({ webSearchEnabled: false })
  ),
}));

vi.mock('@/stores/useVoiceModeStore', () => {
  const voiceState = { isEnabled: false, owner: null as null, enable: vi.fn(), disable: vi.fn() };
  return {
    useVoiceModeStore: vi.fn(
      (selector: (state: typeof voiceState) => unknown) => selector(voiceState)
    ),
  };
});

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: Object.assign(vi.fn(() => ({ register: vi.fn(), unregister: vi.fn() })), {
    getState: vi.fn(() => ({ isAnyEditing: () => false })),
  }),
  isEditingActive: vi.fn(() => false),
}));

// A fresh `[]` literal on every call (unlike the real store's useShallow-backed
// selectors) makes every consumer's downstream useMemo/useEffect see a "changed"
// dependency on every render — confirmed via a local render-count diagnostic to
// cause an unbounded AiChatView re-render loop that OOMs the process. One stable
// empty-array reference restores the real store's shallow-stability contract.
const EMPTY_STREAMS_MOCK: unknown[] = [];
vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: Object.assign(vi.fn(() => EMPTY_STREAMS_MOCK), {
    getState: vi.fn(() => ({
      streams: new Map(),
      getOwnStreams: vi.fn(() => []),
      getRemotePageStreams: vi.fn(() => []),
    })),
  }),
}));

vi.mock('@/hooks/usePageSocketRoom', () => ({ usePageSocketRoom: vi.fn() }));
vi.mock('@/hooks/useChannelStreamSocket', () => ({
  useChannelStreamSocket: vi.fn(() => ({ rejoinActiveStreams: vi.fn() })),
}));
vi.mock('@/hooks/useAppStateRecovery', () => ({ useAppStateRecovery: vi.fn() }));

vi.mock('@/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: vi.fn(() => ({ preferences: { showTokenCounts: false } })),
}));

// Mirror the real barrel. It exported only `clearActiveStreamId` — a function PR 5A deletes with
// the activeStreams map — so every other import from here (useStopStream's whole abort surface)
// silently resolved to `undefined`. Latent only because nothing in this file clicks Stop; a
// landmine for whoever adds that test.
vi.mock('@/lib/ai/core/client', () => ({
  abortActiveStreamByConversation: vi.fn(async () => ({ aborted: true, code: 'aborted', reason: '' })),
  abortActiveStreamByMessageId: vi.fn(async () => ({ aborted: true, code: 'aborted', reason: '' })),
  reportAbortOutcome: vi.fn(),
  reportAbortOutcomes: vi.fn(),
}));
vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStream: vi.fn(),
  abortActiveStreamByMessageId: vi.fn(),
}));
vi.mock('@/lib/ai/core/vision-models', () => ({ hasVisionCapability: vi.fn(() => false) }));

const { historyTabPropsRef } = vi.hoisted(() => ({
  historyTabPropsRef: {
    current: null as null | { onSelectConversation?: (id: string) => void },
  },
}));

// Deliberately real: useConversations, useConversationIdentity, useChatTransport,
// buildChatConfig, conversationIdFrom/isResolving — everything this suite exists
// to exercise for real. Only the pieces that need real browser/DOM/network APIs
// AiChatView doesn't itself own are stubbed out below.
vi.mock('@/lib/ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/shared')>()),
  useMCPTools: vi.fn(() => ({
    isDesktop: false,
    runningServers: [],
    runningServerNames: [],
    mcpToolSchemas: [],
    enabledServerCount: 0,
    isServerEnabled: vi.fn(() => false),
    setServerEnabled: vi.fn(),
    allServersEnabled: false,
    setAllServersEnabled: vi.fn(),
  })),
  useMessageActions: vi.fn(() => ({
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    handleRetry: vi.fn(),
    lastAssistantMessageId: null,
    lastUserMessageId: null,
  })),
  useProviderSettings: vi.fn(() => ({
    isLoading: false,
    isAnyProviderConfigured: true,
    needsSetup: false,
    selectedProvider: 'anthropic',
    setSelectedProvider: vi.fn(),
    selectedModel: 'claude-3-5-sonnet',
    setSelectedModel: vi.fn(),
    isProviderConfigured: vi.fn(() => true),
  })),
  useStreamingRegistration: vi.fn(),
  useSendHandoff: vi.fn(() => ({ wrapSend: vi.fn((cb: () => void) => cb()) })),
  useChatTransport: vi.fn(() => ({})),
  buildChatConfig: vi.fn((params: { id: string; transport: unknown; onError?: (error: Error) => void }) => ({
    id: params.id,
    transport: params.transport,
    experimental_throttle: 100,
    onError: params.onError ?? vi.fn(),
  })),
}));

vi.mock('@/lib/ai/shared/hooks/useImageAttachments', () => {
  const imageAttachState = {
    attachments: [] as unknown[],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    getFilesForSend: vi.fn(() => [] as unknown[]),
  };
  return { useImageAttachments: vi.fn(() => imageAttachState) };
});

vi.mock('@/lib/tree/tree-utils', () => ({ buildPagePath: vi.fn(() => null) }));
vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: vi.fn(() => null),
  PageAgentHistoryTab: vi.fn((props: { onSelectConversation?: (id: string) => void }) => {
    historyTabPropsRef.current = props;
    return null;
  }),
}));
vi.mock('@/components/ai/page-agents/AgentIntegrationsPanel', () => ({
  AgentIntegrationsPanel: vi.fn(() => null),
}));
vi.mock('@/components/ai/voice/VoiceCallPanel', () => ({ VoiceCallPanel: vi.fn(() => null) }));
vi.mock('@/components/ai/shared/chat', () => ({ ProviderSetupCard: vi.fn(() => null) }));
vi.mock('@/components/ai/shared', () => ({
  AiUsageMonitor: vi.fn(() => null),
  TasksDropdown: vi.fn(() => null),
}));
vi.mock('@/components/ai/chat/layouts', () => ({
  ChatLayout: vi.fn(
    (props: {
      renderInput?: (p: Record<string, unknown>) => unknown;
      onStop?: () => void;
      isStreaming?: boolean;
    }) =>
      props.renderInput?.({
        value: '',
        onChange: () => {},
        onSend: () => {},
        onStop: props.onStop,
        isStreaming: props.isStreaming,
        disabled: false,
        placeholder: '',
        driveId: '',
        crossDrive: undefined,
        mcpRunningServers: [],
        mcpServerNames: [],
        mcpEnabledCount: 0,
        mcpAllEnabled: false,
        onMcpToggleAll: () => {},
        isMcpServerEnabled: () => false,
        onMcpServerToggle: () => {},
        showMcp: false,
        inputPosition: 'centered',
      }) ?? null
  ),
}));
vi.mock('@/components/ai/chat/input', () => ({ ChatInput: vi.fn(() => null) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('zustand/react/shallow', () => ({ useShallow: vi.fn((fn: unknown) => fn) }));

vi.mock('@/stores/useFindStore', () => {
  const findState = {
    isOpen: false, query: '', currentIndex: 0, totalMatches: 0,
    open: vi.fn(), close: vi.fn(), setQuery: vi.fn(),
    next: vi.fn(), prev: vi.fn(), reportMatches: vi.fn(), reset: vi.fn(),
  };
  return {
    useFindStore: vi.fn((selector: (s: typeof findState) => unknown) => selector(findState)),
  };
});

import AiChatView from '../AiChatView';
import { PageType } from '@pagespace/lib/utils/enums';
import { useMCPTools } from '@/lib/ai/shared';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';

const latestMcpConversationId = (): string | null => {
  const calls = vi.mocked(useMCPTools).mock.calls;
  const last = calls[calls.length - 1] as [{ conversationId: string | null }] | undefined;
  return last ? last[0].conversationId : null;
};

const PAGE_ID = 'page-123';
const CONV_A = 'conv-a-recent';
const CONV_B = 'conv-b-older';
const CONVERSATIONS_URL = `/api/ai/page-agents/${PAGE_ID}/conversations`;
const MESSAGES_URL_A = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_A}/messages`;
// CONV_B is picked from history — the load-on-select effect's network path (loadMessagesForConversation,
// not the init prefetch) appends ?limit=50 (epic leaf 6.6).
const MESSAGES_URL_B = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_B}/messages?limit=50`;
const AGENT_CONFIG_URL = `/api/pages/${PAGE_ID}/agent-config`;
const PERMISSIONS_URL = `/api/pages/${PAGE_ID}/permissions/check`;

const makeOkResponse = (data: unknown) => ({
  ok: true as const,
  json: vi.fn().mockResolvedValue(data),
});

const makeErrorResponse = () => ({
  ok: false as const,
  json: vi.fn().mockResolvedValue({}),
});

const makePage = () => ({
  id: PAGE_ID,
  title: 'Test Chat',
  type: PageType.AI_CHAT,
  content: null,
  position: 0,
  isTrashed: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  trashedAt: null,
  driveId: 'test-drive-id',
  parentId: null,
  originalParentId: null,
  children: [],
  aiChat: null,
  messages: [],
});

const conversationA = {
  id: CONV_A,
  title: 'Most recent conversation',
  preview: 'hi',
  createdAt: '2024-01-02T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
  messageCount: 1,
  lastMessage: 'hi',
};

const messagesForB = [
  { id: 'b-msg-1', role: 'user', parts: [{ type: 'text', text: 'older question' }] },
  { id: 'b-msg-2', role: 'assistant', parts: [{ type: 'text', text: 'older answer' }] },
];

describe('AiChatView + real useConversations: history select', () => {
  const page = makePage();

  beforeEach(() => {
    vi.clearAllMocks();
    historyTabPropsRef.current = null;
    // Real, unmocked global store — reset between tests, matching AiChatView.test.tsx.
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  test('given a conversation is picked from history, real useConversations.loadConversation should resolve and the picked conversation\'s messages should be applied via setMessages', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [conversationA] });
      }
      if (url === MESSAGES_URL_A && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      if (url === MESSAGES_URL_B && !opts?.method) {
        return makeOkResponse({ messages: messagesForB });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init resolved to the most recent conversation',
        should: 'reflect conv-a as current',
        actual: latestMcpConversationId(),
        expected: CONV_A,
      });
    });

    const historyTrigger = await screen.findByRole('tab', { name: /history/i });
    await userEvent.click(historyTrigger);
    await waitFor(() => {
      assert({
        given: 'the History tab was clicked',
        should: 'mount PageAgentHistoryTab and capture its onSelectConversation prop',
        actual: historyTabPropsRef.current?.onSelectConversation !== undefined,
        expected: true,
      });
    });

    await act(async () => {
      historyTabPropsRef.current?.onSelectConversation?.(CONV_B);
      // Allow the real useConversations.loadConversation fetch (and its
      // onConversationLoad → loadMessagesForConversation → setMessages chain)
      // to actually run to completion.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      assert({
        given: 'conv-b was picked from history and its real messages fetch resolved',
        should: 'call setMessages with conv-b\'s actual messages, not leave the chat empty',
        actual: mockSetMessages.mock.calls.some((args) =>
          Array.isArray(args[0]) && args[0].some((m: { id: string }) => m.id === 'b-msg-1')
        ),
        expected: true,
      });
    });

    assert({
      given: 'conv-b was picked from history',
      should: 'have fetched conv-b\'s messages from the real endpoint',
      actual: (mockFetchWithAuth as unknown as Mock).mock.calls.some((args: unknown[]) => args[0] === MESSAGES_URL_B),
      expected: true,
    });
  });
});
