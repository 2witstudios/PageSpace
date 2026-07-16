import { describe, test, vi, beforeEach, type Mock } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from './riteway';

// Hoisted mock instances accessible inside vi.mock factories
const { mockFetchWithAuth, mockSetMessages, mockSendMessage, mockLocalStop, mockAbortByMessageId, mockAbortByConversation } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockSetMessages: vi.fn(),
  mockSendMessage: vi.fn(),
  mockLocalStop: vi.fn(),
  mockAbortByMessageId: vi.fn(async (_args: { messageId: string }) => ({
    aborted: true,
    code: 'aborted' as const,
    reason: '',
  })),
  mockAbortByConversation: vi.fn(async (_args: { conversationId: string }) => ({
    aborted: true,
    code: 'aborted' as const,
    reason: '',
  })),
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
    sendMessage: mockSendMessage,
    status: 'idle' as const,
    error: undefined as Error | undefined,
    regenerate: vi.fn(),
    setMessages: mockSetMessages,
    stop: vi.fn(),
  };
  return { useChat: vi.fn(() => chatState) };
});

vi.mock('swr', () => {
  const swrCache = { get: vi.fn(() => undefined) };
  return {
    default: vi.fn(() => ({ data: undefined, error: undefined })),
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
  useEditingStore: vi.fn(() => ({ register: vi.fn(), unregister: vi.fn() })),
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

// The client barrel re-exports the abort surface, and `useStopStream` (the shared Stop action)
// imports from it — the barrel is the sanctioned entry point for React code. This mock used to
// export ONLY `clearActiveStreamId`, a function PR 5A deleted along with the activeStreams map;
// anything else imported from here silently resolved to `undefined`. Mirror the real barrel.
vi.mock('@/lib/ai/core/client', () => ({
  abortActiveStreamByConversation: mockAbortByConversation,
  abortActiveStreamByMessageId: mockAbortByMessageId,
  reportAbortOutcome: vi.fn(),
  reportAbortOutcomes: vi.fn(),
}));
// The abort functions must RESOLVE: Stop now chains the outcome into reportAbortOutcome, so that
// a stream which could not be confirmed stopped (still running, still billing) reaches the user.
const NOT_FOUND = { aborted: false, code: 'not_found' as const, reason: 'nothing in flight' };
vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStream: vi.fn(async () => NOT_FOUND),
  abortActiveStreamByMessageId: mockAbortByMessageId,
  reportAbortOutcome: vi.fn(),
  reportAbortOutcomes: vi.fn(),
}));
vi.mock('@/lib/ai/core/vision-models', () => ({ hasVisionCapability: vi.fn(() => false) }));

const { mockCreateConversation, mockRefreshConversations, mockLoadConversation, useConversationsOptionsRef, historyTabPropsRef } = vi.hoisted(() => ({
  mockCreateConversation: vi.fn(),
  mockRefreshConversations: vi.fn(),
  mockLoadConversation: vi.fn(),
  // Captures the options passed to useConversations() on each render so tests
  // can simulate the real hook's callback contract (onConversationCreate fires
  // synchronously, before any network round trip resolves).
  useConversationsOptionsRef: {
    current: null as null | {
      onConversationCreate?: (id: string) => void;
      onConversationLoad?: (id: string, messages: unknown[]) => void;
    },
  },
  historyTabPropsRef: {
    current: null as null | { onSelectConversation?: (id: string) => void },
  },
}));

vi.mock('@/lib/ai/shared', async (importOriginal) => ({
  // useConversationIdentity is intentionally left as the real implementation:
  // it's a simple, independently-tested wrapper, and these tests rely on its
  // real resolve()-on-mount behavior to exercise resolveConversation's fetch
  // sequence (the thing this suite is actually testing).
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
  useConversations: vi.fn((options: {
    onConversationCreate?: (id: string) => void;
    onConversationLoad?: (id: string, messages: unknown[]) => void;
  }) => {
    useConversationsOptionsRef.current = options;
    return {
      conversations: [],
      isLoading: false,
      loadConversation: mockLoadConversation,
      createConversation: mockCreateConversation,
      deleteConversation: vi.fn(),
      refreshConversations: mockRefreshConversations,
      prependConversationOptimistic: vi.fn(),
    };
  }),
  useChatTransport: vi.fn(() => ({})),
  useStreamingRegistration: vi.fn(),
  useChatStop: vi.fn(() => mockLocalStop),
  useSendHandoff: vi.fn(() => ({ wrapSend: vi.fn((cb: () => void) => cb()) })),
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
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { ChatLayout } from '@/components/ai/chat/layouts';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';
import { useMCPTools } from '@/lib/ai/shared';

// The most recently observed conversationId — useMCPTools({ conversationId })
// is called on every render, so its latest call args are a reliable, already-
// mocked signal for "what does AiChatView currently believe currentConversationId is",
// without needing to click through the (also mocked) ChatLayout/PageAgentHistoryTab.
const latestMcpConversationId = (): string | null => {
  const calls = vi.mocked(useMCPTools).mock.calls;
  const last = calls[calls.length - 1] as [{ conversationId: string | null }] | undefined;
  return last ? last[0].conversationId : null;
};

// "The init fetch was called" is NOT enough before firing onStreamComplete:
// identity only becomes the page-scoped placeholder after the resolve chain
// flushes (fetch → json → dispatch RESOLVED → re-render). If the callback
// fires inside that window, isPlaceholderConversationId() is false, the
// late-joiner branch is skipped, and the sync fetch never starts — under CI
// load this window is wide enough to hit. Wait for the resolved identity.
// A page with no conversations yet resolves to a freshly minted cuid — NOT the old
// `${pageId}-default` sentinel, which the server accepted unvalidated and wrote real
// conversation rows under, and which both client load paths then hard-bailed on (so
// the messages persisted and were never loaded back).
const waitForUnpersistedIdentity = (pageId: string) =>
  waitFor(() => {
    const id = latestMcpConversationId();
    expect(id).not.toBe(`${pageId}-default`);
    expect(id !== null && isCuid(id)).toBe(true);
  });

const PAGE_ID = 'page-123';
const CONV_ID = 'conv-existing-abc';
const CONVERSATIONS_URL = `/api/ai/page-agents/${PAGE_ID}/conversations`;
const MESSAGES_URL = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_ID}/messages`;
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

const existingConversation = {
  id: CONV_ID,
  title: 'Existing conversation',
  preview: 'hello',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  messageCount: 1,
  lastMessage: 'hello',
};

const wasGetCalled = (url: string) =>
  (mockFetchWithAuth.mock.calls as Parameters<typeof fetchWithAuth>[]).some(([callUrl, opts]) =>
    callUrl === url && (!opts?.method || opts.method === 'GET')
  );

const wasPostCalled = (url: string) =>
  (mockFetchWithAuth.mock.calls as Parameters<typeof fetchWithAuth>[]).some(([callUrl, opts]) =>
    callUrl === url && opts?.method === 'POST'
  );

// AC3 step 1 — the migration-free recovery path.
//
// The client used to send a `${pageId}-default` sentinel as the conversation id for a
// brand-new chat. The server accepted it unvalidated and minted a REAL conversations row
// under that id, stamping every message to it. Both client load paths then hard-bailed on
// that exact string, and loadMessagesForConversation was the only setMessages writer — so
// the messages were persisted and then never loaded. Every such page rendered an empty
// chat after any reload.
//
// Those rows exist in production. Identity now carries `isPersisted` instead of pattern-
// matching the id, so a sentinel conversation coming back from the list loads like any
// other one. That is what gives existing users their history back, with no data migration.
describe('AiChatView — legacy `${pageId}-default` conversation (no migration)', () => {
  const page = makePage();
  const LEGACY_CONV_ID = `${PAGE_ID}-default`;
  const LEGACY_MESSAGES_URL = `${CONVERSATIONS_URL}/${LEGACY_CONV_ID}/messages`;

  beforeEach(() => {
    vi.clearAllMocks();
    // Real, unmocked global store — reset between tests or byConversationId
    // only grows across this file's whole run (mirrors useConversationMessagesStore.test.ts).
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  const strandedMessages = [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what did we decide?' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'the stranded reply' }] },
  ];

  const setupLegacyConversation = () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [{ id: LEGACY_CONV_ID, title: 'Legacy', preview: '' }] });
      }
      if (url === LEGACY_MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: strandedMessages });
      }
      return makeErrorResponse();
    });
  };

  test('given a persisted conversation whose id is the old `${pageId}-default` sentinel, should fetch its messages instead of bailing on the id string', async () => {
    setupLegacyConversation();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a persisted conversation whose id happens to be the legacy sentinel',
        should: 'fetch its messages (the old code hard-bailed on this exact string)',
        actual: wasGetCalled(LEGACY_MESSAGES_URL),
        expected: true,
      });
    });
  });

  test('given the legacy conversation loads, should write its stranded history into the chat', async () => {
    setupLegacyConversation();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a legacy sentinel conversation with persisted messages',
        should: 'setMessages with the recovered history',
        actual: mockSetMessages.mock.calls.some(
          (args) => Array.isArray(args[0]) && (args[0] as Array<{ id: string }>).some((m) => m.id === 'm2'),
        ),
        expected: true,
      });
    });
  });

  test('given the legacy conversation is active, should adopt it as the conversation identity (so a send continues it rather than forking a new one)', async () => {
    setupLegacyConversation();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a legacy sentinel conversation returned by the list',
        should: 'use it as the active conversation id',
        actual: latestMcpConversationId(),
        expected: LEGACY_CONV_ID,
      });
    });
  });
});

// AC3 step 2 + the hazard it creates.
//
// A brand-new chat resolves to a freshly minted cuid that has no server-side
// conversation yet, so the loaders skip it. The first send creates that conversation
// row under exactly this id — the id becomes real, and the loaders must stop skipping
// it. But flipping that flag re-runs the load-on-select effect for the SAME id, and if
// it were allowed to fetch, it would pull a conversation whose first message has not
// been written yet and setMessages([]) straight over the optimistic user bubble and the
// in-flight stream. Sending must claim the skip token before flipping.
describe('AiChatView — first send on a freshly minted conversation', () => {
  const page = makePage();

  beforeEach(() => {
    vi.clearAllMocks();
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  const setupNoConversations = () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [] });
      }
      // The freshly-minted conversation exists but has no messages yet — the exact
      // window a stray load-on-select fetch would blank the chat in.
      if (url.includes('/messages') && !opts?.method) return makeOkResponse({ messages: [] });
      return makeErrorResponse();
    });
  };

  const lastChatLayoutProps = () => {
    const calls = (ChatLayout as unknown as Mock).mock.calls;
    return calls[calls.length - 1]?.[0] as { onSend: () => void; input: string } | undefined;
  };

  test('given the first send on a freshly minted conversation, should NOT fetch messages for it (a stray load would blank the optimistic bubble)', async () => {
    setupNoConversations();
    render(<AiChatView page={page} />);

    await waitForUnpersistedIdentity(PAGE_ID);
    const mintedId = latestMcpConversationId();

    // Type something, then send.
    act(() => {
      (ChatLayout as unknown as Mock).mock.calls[
        (ChatLayout as unknown as Mock).mock.calls.length - 1
      ][0].onInputChange?.('hello');
    });
    act(() => {
      lastChatLayoutProps()?.onSend();
    });

    await waitFor(() => {
      assert({
        given: 'a first send on a freshly minted conversation',
        should: 'hand the message to useChat',
        actual: mockSendMessage.mock.calls.length > 0,
        expected: true,
      });
    });

    assert({
      given: 'the conversation flipping to persisted on send',
      should: 'not fetch that conversation\'s messages (the skip token was claimed first)',
      actual: wasGetCalled(`${CONVERSATIONS_URL}/${mintedId}/messages`),
      expected: false,
    });
  });

  test('given the first send, should never blank the messages array', async () => {
    setupNoConversations();
    render(<AiChatView page={page} />);

    await waitForUnpersistedIdentity(PAGE_ID);

    const blanksBefore = mockSetMessages.mock.calls.filter(
      (args) => Array.isArray(args[0]) && (args[0] as unknown[]).length === 0,
    ).length;

    act(() => {
      (ChatLayout as unknown as Mock).mock.calls[
        (ChatLayout as unknown as Mock).mock.calls.length - 1
      ][0].onInputChange?.('hello');
    });
    act(() => {
      lastChatLayoutProps()?.onSend();
    });

    await waitFor(() => {
      assert({
        given: 'a first send',
        should: 'hand the message to useChat',
        actual: mockSendMessage.mock.calls.length > 0,
        expected: true,
      });
    });

    const blanksAfter = mockSetMessages.mock.calls.filter(
      (args) => Array.isArray(args[0]) && (args[0] as unknown[]).length === 0,
    ).length;

    assert({
      given: 'the conversation flipping to persisted mid-send',
      should: 'never call setMessages([]) over the optimistic user bubble',
      actual: blanksAfter,
      expected: blanksBefore,
    });
  });
});

describe('AiChatView initializeChat', () => {
  const page = makePage();

  beforeEach(() => {
    vi.clearAllMocks();
    useConversationMessagesStore.setState({ byConversationId: {} });
    useConversationsOptionsRef.current = null;
    historyTabPropsRef.current = null;
  });

  test('given a page with existing conversations, loads the most recent conversation without creating a new one', async () => {
    const testMessages = [{ id: 'msg-1', role: 'user', content: 'hello', parts: [{ type: 'text', text: 'hello' }] }];

    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: testMessages });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a page with existing conversations',
        should: 'GET conversations list (not POST)',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });

    assert({
      given: 'a page with existing conversations',
      should: 'NOT create a new conversation via POST',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: false,
    });

    // Applying preloaded messages now happens via the load-on-select effect
    // reacting to the identity becoming ready — one more async tick than the
    // old inline call chain, so this needs its own waitFor.
    await waitFor(() => {
      assert({
        given: 'a page with existing conversations',
        should: 'apply the fetched messages to chat state',
        actual: mockSetMessages.mock.calls.some(
          (args) => JSON.stringify(args[0]) === JSON.stringify(testMessages)
        ),
        expected: true,
      });
    });
  });

  test('given a page with no conversations, uses a page-scoped deterministic ID without POSTing', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [] });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a brand-new page with no conversations',
        should: 'GET conversations list first',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });

    assert({
      given: 'a brand-new page with no conversations',
      should: 'NOT POST a server-side conversation (avoids race between concurrent openers)',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: false,
    });
  });

  test('given conversations fetch fails with non-ok response, falls back to page-scoped deterministic ID without POSTing', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeErrorResponse();
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'conversations GET returns non-ok',
        should: 'attempt to GET conversations first',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });

    assert({
      given: 'conversations GET returns non-ok',
      should: 'NOT POST — fall back to page-scoped deterministic ID',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: false,
    });
  });

  test('given conversations GET throws a network error, falls back to page-scoped deterministic ID without POSTing', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        throw new Error('network error');
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'conversations GET throws',
        should: 'attempt to GET conversations first',
        actual: (mockFetchWithAuth.mock.calls as Parameters<typeof fetchWithAuth>[]).some(
          ([callUrl]) => callUrl === `${CONVERSATIONS_URL}?pageSize=1`
        ),
        expected: true,
      });
    });

    assert({
      given: 'conversations GET throws',
      should: 'NOT POST — fall back to page-scoped deterministic ID',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: false,
    });
  });

  test('given two users opening the same page, both load the same existing conversation by fetching its messages', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a second user opening the same page',
        should: 'load messages from the shared existing conversation',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    assert({
      given: 'a second user opening the same page',
      should: 'NOT create a new separate conversation',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: false,
    });
  });

  test('given user clicks New Chat button, createConversation from useConversations is called', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    const newChatButton = await screen.findByRole('button', { name: /new chat/i });
    fireEvent.click(newChatButton);

    assert({
      given: 'user clicks the New Chat button',
      should: 'call createConversation from useConversations (no change to existing behavior)',
      actual: mockCreateConversation.mock.calls.length,
      expected: 1,
    });
  });

  test('given New Chat succeeds, should adopt the new conversationId synchronously — before the create persist would resolve', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      return makeErrorResponse();
    });

    // Mirrors the real hook: createConversation invokes onConversationCreate
    // synchronously, then persists — the persist here never resolves, so if
    // identity depended on it, currentConversationId would never update.
    mockCreateConversation.mockImplementation(() => {
      useConversationsOptionsRef.current?.onConversationCreate?.('new-conv-xyz');
      return new Promise(() => {});
    });

    render(<AiChatView page={page} />);
    await waitFor(() => {
      assert({
        given: 'init has resolved to the existing conversation',
        should: 'reflect it via useMCPTools',
        actual: latestMcpConversationId(),
        expected: CONV_ID,
      });
    });

    const newChatButton = await screen.findByRole('button', { name: /new chat/i });
    fireEvent.click(newChatButton);

    assert({
      given: 'New Chat was clicked and createConversation invoked its callback',
      should: 'adopt the new conversationId immediately, without waiting for the persist to resolve',
      actual: latestMcpConversationId(),
      expected: 'new-conv-xyz',
    });
  });

  test('given a conversation is selected from history, should adopt its id synchronously — before useConversations.loadConversation resolves', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      return makeErrorResponse();
    });
    // loadConversation's own fetch never resolves — proves identity doesn't wait on it.
    mockLoadConversation.mockImplementation(() => new Promise(() => {}));

    render(<AiChatView page={page} />);
    await waitFor(() => {
      assert({
        given: 'init has resolved to the existing conversation',
        should: 'reflect it via useMCPTools',
        actual: latestMcpConversationId(),
        expected: CONV_ID,
      });
    });

    // PageAgentHistoryTab only mounts (and its props get captured) once the
    // History tab is active — Radix Tabs doesn't render inactive TabsContent
    // children by default.
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

    act(() => {
      // Invokes the onSelectConversation wrapper AiChatView passes to
      // PageAgentHistoryTab — setIdentity fires before loadConversation's
      // fetch (mocked above to hang forever) has any chance to resolve.
      historyTabPropsRef.current?.onSelectConversation?.('selected-from-history-id');
    });

    assert({
      given: 'a conversation was selected from history',
      should: 'adopt its id immediately, without waiting for loadConversation to resolve',
      actual: latestMcpConversationId(),
      expected: 'selected-from-history-id',
    });
  });

  test('given a conversation is selected from history, should fetch its messages directly via the load-on-select effect (not via useConversations.loadConversation)', async () => {
    const HISTORY_CONV_ID = 'history-selected-conv';
    const HISTORY_MESSAGES_URL = `/api/ai/page-agents/${PAGE_ID}/conversations/${HISTORY_CONV_ID}/messages`;

    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      if (url === HISTORY_MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [{ id: 'history-conv-msg', role: 'assistant', parts: [] }] });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);
    await waitFor(() => expect(latestMcpConversationId()).toBe(CONV_ID));

    const historyTrigger = await screen.findByRole('tab', { name: /history/i });
    await userEvent.click(historyTrigger);
    await waitFor(() => expect(historyTabPropsRef.current?.onSelectConversation).toBeDefined());

    act(() => {
      historyTabPropsRef.current!.onSelectConversation!(HISTORY_CONV_ID);
    });

    await waitFor(() => {
      assert({
        given: 'a conversation was selected from history',
        should: 'fetch that conversation\'s messages directly over the network',
        actual: mockFetchWithAuth.mock.calls.some(([url]) => url === HISTORY_MESSAGES_URL),
        expected: true,
      });
    });

    await waitFor(() => {
      assert({
        given: 'a conversation was selected from history',
        should: 'apply the fetched messages',
        actual: mockSetMessages.mock.calls.some((args) =>
          Array.isArray(args[0]) && args[0].some((m: { id: string }) => m.id === 'history-conv-msg')
        ),
        expected: true,
      });
    });

    assert({
      given: 'a conversation was selected from history',
      should: 'never call useConversations.loadConversation (history-select no longer routes through it)',
      actual: mockLoadConversation.mock.calls.length,
      expected: 0,
    });
  });

  test('given the user switches to a second history conversation before the first one\'s messages fetch resolves, should apply the second (latest) selection\'s messages even if the first one\'s fetch resolves last', async () => {
    const CONV_Y = 'history-conv-y';
    const CONV_Z = 'history-conv-z';
    const MESSAGES_URL_Y = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_Y}/messages`;
    const MESSAGES_URL_Z = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_Z}/messages`;

    let resolveY!: (value: unknown) => void;
    const pendingY = new Promise((resolve) => { resolveY = resolve; });

    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      // Y's fetch hangs until resolveY() is called explicitly below — simulates
      // Y's response arriving on the wire AFTER Z's, even though Y was clicked first.
      if (url === MESSAGES_URL_Y && !opts?.method) return pendingY;
      if (url === MESSAGES_URL_Z && !opts?.method) {
        return makeOkResponse({ messages: [{ id: 'z-msg', role: 'assistant', parts: [] }] });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);
    await waitFor(() => expect(latestMcpConversationId()).toBe(CONV_ID));

    const historyTrigger = await screen.findByRole('tab', { name: /history/i });
    await userEvent.click(historyTrigger);
    await waitFor(() => expect(historyTabPropsRef.current?.onSelectConversation).toBeDefined());

    // Click Y, then immediately click Z (Z is the user's true final selection).
    act(() => {
      historyTabPropsRef.current!.onSelectConversation!(CONV_Y);
    });
    act(() => {
      historyTabPropsRef.current!.onSelectConversation!(CONV_Z);
    });

    // Z resolves quickly (mocked as immediate above); wait for its messages to land.
    await waitFor(() => {
      assert({
        given: 'Y was clicked then Z was clicked before Y\'s fetch resolved',
        should: 'apply Z\'s messages once its fetch resolves',
        actual: mockSetMessages.mock.calls.some((args) =>
          Array.isArray(args[0]) && args[0].some((m: { id: string }) => m.id === 'z-msg')
        ),
        expected: true,
      });
    });

    // Now let Y's stale, slow fetch finally resolve.
    await act(async () => {
      resolveY(makeOkResponse({ messages: [{ id: 'y-msg-stale', role: 'assistant', parts: [] }] }));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert({
      given: 'Y\'s fetch resolves last, after Z\'s messages were already applied',
      should: 'NOT clobber the display with Y\'s stale messages — the user is on Z',
      actual: mockSetMessages.mock.calls.some((args) =>
        Array.isArray(args[0]) && args[0].some((m: { id: string }) => m.id === 'y-msg-stale')
      ),
      expected: false,
    });
  });

  test('given the conversations-list fetch fails during init, should surface a retry state instead of silently falling back to the page-scoped placeholder', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        throw new Error('network down');
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await screen.findByText(/Failed to load this conversation/i);

    assert({
      given: 'the conversations-list fetch threw during init',
      should: 'never adopt the page-scoped default placeholder id',
      actual: latestMcpConversationId(),
      expected: null,
    });
  });

  test('given the conversation IS found but its messages-prefetch fetch throws, should NOT treat this as an identity-resolution failure', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        // The list-fetch succeeded (conversation identity IS known) but the
        // messages-prefetch throws — a transient blip on a *different*
        // request than the one that determines identity.
        throw new Error('network blip on messages prefetch');
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    // The conversation was found — identity should resolve normally, NOT
    // surface the top-level resolution-failure banner.
    await waitFor(() => {
      assert({
        given: 'the messages-prefetch fetch threw but the conversation was found',
        should: 'still adopt the known conversation id',
        actual: latestMcpConversationId(),
        expected: CONV_ID,
      });
    });

    assert({
      given: 'the messages-prefetch fetch threw but the conversation was found',
      should: 'NOT show the top-level identity-resolution-failure banner',
      actual: screen.queryByText(/Failed to load this conversation/i),
      expected: null,
    });
  });
});

describe('AiChatView late-joiner conversation sync', () => {
  const page = makePage();
  const MESSAGE_ID = 'msg-late-joiner';
  const REAL_CONV_ID = 'real-conv-id';

  beforeEach(() => {
    vi.clearAllMocks();
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  const setupNoConversationsInit = () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) return makeOkResponse({ conversations: [] });
      return makeErrorResponse();
    });
  };

  test('given fireComplete fires with stream.conversationId matching the persisted conversation while currentConversationId is the page-scoped default, should sync ID and append the message', async () => {
    let capturedCallback: ((messageId: string, completedConvId?: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) {
        return makeOkResponse({ conversations: [{ id: REAL_CONV_ID }] });
      }
      return makeErrorResponse();
    });

    capturedCallback?.(MESSAGE_ID, REAL_CONV_ID);

    // This surface is store-first (see file header): the late-joiner reconciliation
    // path (AiChatView's onStreamComplete, `!isPersistedRef.current` branch) commits
    // the synthesized message via conversationMessagesActions.applyConfirmedMessage,
    // not the legacy useChat setMessages — so "should append the message" is verified
    // against useConversationMessagesStore, and "should sync ID" against the id every
    // render passes down to useMCPTools.
    await waitFor(() => {
      assert({
        given: 'stream.conversationId matches the persisted conversation while holding page-scoped default',
        should: 'sync currentConversationId to the persisted conversation',
        actual: latestMcpConversationId(),
        expected: REAL_CONV_ID,
      });
    });

    await waitFor(() => {
      const entry = useConversationMessagesStore.getState().byConversationId[REAL_CONV_ID];
      assert({
        given: 'stream.conversationId matches the persisted conversation while holding page-scoped default',
        should: 'append the completed AI message to that conversation\'s store entry',
        actual: entry?.messages.some((m) => m.id === MESSAGE_ID),
        expected: true,
      });
    });
  });

  test('given the late-joiner sync resolves currentConversationId to a conversation absent from the cached list, should refresh the conversation list so the header toggle and History reflect the new conversation', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    // The page-scoped placeholder id must not trigger a refresh (nothing persisted yet).
    assert({
      given: 'only the page-scoped placeholder conversation is active',
      should: 'not refresh the conversation list',
      actual: mockRefreshConversations.mock.calls.length,
      expected: 0,
    });

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) {
        return makeOkResponse({ conversations: [{ id: REAL_CONV_ID }] });
      }
      return makeErrorResponse();
    });

    capturedCallback?.(MESSAGE_ID);

    await waitFor(() => {
      assert({
        given: 'a freshly-created conversation became active but is absent from the cached (empty) list',
        should: 'refresh the conversation list',
        actual: mockRefreshConversations.mock.calls.length > 0,
        expected: true,
      });
    });
  });

  test('given fireComplete fires with stream.conversationId that does NOT match the persisted conversation, should NOT append the message', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) {
        return makeOkResponse({ conversations: [{ id: 'different-conv-id' }] });
      }
      return makeErrorResponse();
    });

    const setMessagesCallsBefore = mockSetMessages.mock.calls.length;
    capturedCallback?.(MESSAGE_ID);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert({
      given: 'GET returns a different conversation id than stream.conversationId',
      should: 'NOT append any message',
      actual: mockSetMessages.mock.calls.length,
      expected: setMessagesCallsBefore,
    });
  });

  test('given the sync fetch returns !res.ok, should NOT append any message', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) return makeErrorResponse();
      return makeErrorResponse();
    });

    const setMessagesCallsBefore = mockSetMessages.mock.calls.length;
    capturedCallback?.(MESSAGE_ID);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert({
      given: 'sync fetch returns !res.ok',
      should: 'NOT append any message',
      actual: mockSetMessages.mock.calls.length,
      expected: setMessagesCallsBefore,
    });
  });

  test('given the sync fetch returns an empty conversations array, should NOT append any message', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) return makeOkResponse({ conversations: [] });
      return makeErrorResponse();
    });

    const setMessagesCallsBefore = mockSetMessages.mock.calls.length;
    capturedCallback?.(MESSAGE_ID);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert({
      given: 'sync fetch returns empty conversations array',
      should: 'NOT append any message',
      actual: mockSetMessages.mock.calls.length,
      expected: setMessagesCallsBefore,
    });
  });

  test('given the sync fetch throws a network error, should warn and NOT append any message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) throw new Error('network error');
      return makeErrorResponse();
    });

    const setMessagesCallsBefore = mockSetMessages.mock.calls.length;
    capturedCallback?.(MESSAGE_ID);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert({
      given: 'sync fetch throws a network error',
      should: 'call console.warn',
      actual: warnSpy.mock.calls.length > 0,
      expected: true,
    });

    assert({
      given: 'sync fetch throws a network error',
      should: 'NOT append any message',
      actual: mockSetMessages.mock.calls.length,
      expected: setMessagesCallsBefore,
    });

    warnSpy.mockRestore();
  });

  test('given the component navigates to a different page while the sync fetch is in-flight, should NOT apply stale page-A state to page B', async () => {
    const PAGE_B_ID = 'page-b-456';
    let capturedPageACallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((pageId, opts) => {
      if (pageId === PAGE_ID) capturedPageACallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    let resolveSyncFetch!: () => void;
    const syncFetchReady = new Promise<void>((resolve) => { resolveSyncFetch = resolve; });

    let pageAConvCallCount = 0;
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === `/api/pages/${PAGE_B_ID}/permissions/check`) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `/api/pages/${PAGE_B_ID}/agent-config`) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) {
        pageAConvCallCount++;
        if (pageAConvCallCount === 1) return makeOkResponse({ conversations: [] }); // init
        await syncFetchReady;
        return makeOkResponse({ conversations: [{ id: REAL_CONV_ID }] }); // sync (deferred)
      }
      if (url === `/api/ai/page-agents/${PAGE_B_ID}/conversations?pageSize=1`) {
        return makeOkResponse({ conversations: [] }); // page B init
      }
      return makeErrorResponse();
    });

    const pageBObj = { ...makePage(), id: PAGE_B_ID };
    const { rerender } = render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'page A init',
        should: 'have fetched conversations',
        actual: pageAConvCallCount >= 1,
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI from page A' }], conversationId: REAL_CONV_ID }]]),
    });

    // Trigger the late-joiner sync (starts the deferred fetch)
    capturedPageACallback?.(MESSAGE_ID);

    // Navigate to page B — this should update pageIdRef.current
    rerender(<AiChatView page={pageBObj} />);

    const callsBefore = mockSetMessages.mock.calls.length;

    // Resolve the deferred fetch (page A's conversation data arrives after navigation)
    await act(async () => { resolveSyncFetch(); });

    // The stale late-joiner sync would use a functional update: setMessages((prev) => [...prev, msg])
    // Page B's legitimate init uses a direct array: setMessages([])
    // So we check that no functional-update calls were added after callsBefore
    const functionalCallsAfterNav = mockSetMessages.mock.calls
      .slice(callsBefore)
      .filter((args) => typeof args[0] === 'function');

    assert({
      given: 'page A sync fetch resolves after navigating to page B',
      should: 'NOT make any functional setMessages calls (stale page-A append)',
      actual: functionalCallsAfterNav.length,
      expected: 0,
    });
  });

  test('given the user switches to a different conversation while the late-joiner sync fetch is in-flight, should NOT snap identity back to the stale synced conversation', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      capturedCallback = opts?.onStreamComplete;
      return { rejoinActiveStreams: vi.fn() };
    });

    setupNoConversationsInit();
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with no existing conversations',
        should: 'fetch conversations list',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });
    await waitForUnpersistedIdentity(PAGE_ID);

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { parts: [{ type: 'text', text: 'AI response' }], conversationId: REAL_CONV_ID }]]),
    });

    let resolveSyncFetch!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `${CONVERSATIONS_URL}?pageSize=1`) {
        return new Promise((resolve) => { resolveSyncFetch = resolve; });
      }
      return Promise.resolve(makeErrorResponse());
    });

    // Trigger the late-joiner sync (starts the deferred list-fetch).
    capturedCallback?.(MESSAGE_ID);

    // The History tab must be mounted to capture onSelectConversation.
    const historyTrigger = await screen.findByRole('tab', { name: /history/i });
    await userEvent.click(historyTrigger);
    await waitFor(() => expect(historyTabPropsRef.current?.onSelectConversation).toBeDefined());

    // User explicitly switches to a different, already-known conversation
    // while the late-joiner's fetch is still pending.
    act(() => {
      historyTabPropsRef.current!.onSelectConversation!('user-switched-id');
    });
    expect(latestMcpConversationId()).toBe('user-switched-id');

    // The late-joiner's list-fetch is deferred, so under load it may not have
    // started yet — wait until the mock has captured its resolver before
    // resolving, or this dereferences undefined and flakes.
    await waitFor(() => expect(resolveSyncFetch).toBeDefined());

    // The late-joiner's deferred fetch now resolves, matching stream.conversationId —
    // it must not clobber the identity the user already switched to.
    await act(async () => {
      resolveSyncFetch(makeOkResponse({ conversations: [{ id: REAL_CONV_ID }] }));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert({
      given: 'the late-joiner sync resolved after the user switched conversations',
      should: 'NOT snap identity back to the stale synced conversation',
      actual: latestMcpConversationId(),
      expected: 'user-switched-id',
    });
  });
});

describe('AiChatView remote user-message broadcast', () => {
  const page = makePage();

  type UserMsgCallback = (
    msg: { id: string; role: string; parts: unknown[] },
    payload: { conversationId: string },
  ) => void;

  const captureCallback = () => {
    let captured: UserMsgCallback | undefined;
    vi.mocked(useChannelStreamSocket).mockImplementation((_pageId, opts) => {
      captured = opts?.onUserMessage as UserMsgCallback | undefined;
      return { rejoinActiveStreams: vi.fn() };
    });
    return () => captured;
  };

  const setupExistingConversation = (testMessages: { id: string; role: string }[] = []) => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: testMessages });
      }
      return makeErrorResponse();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  test('given onUserMessage fires with conversationId matching the active conversation, should append the message', async () => {
    const getCb = captureCallback();
    setupExistingConversation([]);
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with existing conversation',
        should: 'load conversation messages',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    const userMsg = { id: 'msg-from-alice', role: 'user' as const, parts: [{ type: 'text', text: 'hi from Alice' }] };
    act(() => {
      getCb()?.(userMsg, { conversationId: CONV_ID });
    });

    assert({
      given: 'a remote user-message event for the active conversation',
      should: 'append it to messages via setMessages',
      actual: mockSetMessages.mock.calls.some((args) => typeof args[0] === 'function'),
      expected: true,
    });
  });

  test('given onUserMessage fires for a conversationId different from the current one, should NOT append', async () => {
    const getCb = captureCallback();
    setupExistingConversation([]);
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with existing conversation',
        should: 'load conversation messages',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    const callsBefore = mockSetMessages.mock.calls.filter((a) => typeof a[0] === 'function').length;
    const userMsg = { id: 'msg-from-other-conv', role: 'user' as const, parts: [{ type: 'text', text: 'wrong conv' }] };
    act(() => {
      getCb()?.(userMsg, { conversationId: 'different-conv-id' });
    });

    const callsAfter = mockSetMessages.mock.calls.filter((a) => typeof a[0] === 'function').length;
    assert({
      given: 'a remote user-message event for a different conversation',
      should: 'NOT append (no functional setMessages call added)',
      actual: callsAfter,
      expected: callsBefore,
    });
  });

  test('given onUserMessage fires with a messageId already present in messages, should NOT append a duplicate', async () => {
    const getCb = captureCallback();
    const existingMsg = { id: 'msg-already-there', role: 'user' as const, parts: [{ type: 'text', text: 'duplicate' }] };
    setupExistingConversation([existingMsg]);
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with existing conversation that includes the message',
        should: 'load conversation messages',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    const callsBefore = mockSetMessages.mock.calls.filter((a) => typeof a[0] === 'function').length;
    act(() => {
      getCb()?.(existingMsg, { conversationId: CONV_ID });
    });
    // The handler may invoke setMessages with an updater that returns prev unchanged;
    // verify the resulting messages array has no duplicate.
    const allFunctional = mockSetMessages.mock.calls
      .slice(callsBefore)
      .filter((a) => typeof a[0] === 'function')
      .map((a) => (a[0] as (prev: unknown[]) => unknown[])([existingMsg]));

    const noDup = allFunctional.every(
      (next) => (next as Array<{ id: string }>).filter((m) => m.id === existingMsg.id).length === 1,
    );

    assert({
      given: 'a remote user-message event whose messageId is already in messages',
      should: 'leave the array with a single copy of that messageId',
      actual: noDup,
      expected: true,
    });
  });
});

describe('AiChatView stop button for reconnected own streams', () => {
  const page = makePage();

  type StreamEntry = { messageId: string; pageId: string; isOwn: boolean; conversationId: string };

  type StoreState = {
    streams: Map<string, StreamEntry>;
    getRemotePageStreams: (pageId: string) => unknown[];
    getOwnStreams: (pageId: string) => Array<{ messageId: string; pageId: string; isOwn: true; conversationId: string }>;
  };

  // `streams` is built from the SAME entries the accessors return, because that is the one thing
  // the real store guarantees: `getOwnStreams`/`getRemotePageStreams` are derived views OVER
  // `streams`, so they cannot disagree with it. This helper used to hand back an EMPTY `streams`
  // Map alongside populated accessors — a state the store can never actually be in, which meant
  // any consumer reading the Map (rather than an accessor) saw "no streams" while the test
  // believed it had set one up. A mock that can hold an impossible state hides bugs instead of
  // finding them.
  const setStoreSelectors = ({
    remote = [],
    own = [],
  }: {
    remote?: StreamEntry[];
    own?: Array<{ messageId: string; pageId: string; isOwn: true; conversationId: string }>;
  }) => {
    const all: StreamEntry[] = [...remote, ...own];
    const state: StoreState = {
      streams: new Map(all.map((entry) => [entry.messageId, entry])),
      getRemotePageStreams: () => remote,
      getOwnStreams: () => own,
    };
    (usePendingStreamsStore as unknown as Mock).mockImplementation(
      (selector: (s: StoreState) => unknown) => selector(state)
    );
  };

  const setupHappyInit = () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({ messages: [] });
      }
      return makeErrorResponse();
    });
  };

  const lastChatLayoutProps = () => {
    const calls = (ChatLayout as unknown as Mock).mock.calls;
    return calls[calls.length - 1]?.[0] as
      | { isStreaming: boolean; onStop: () => void; remoteStreams: unknown[] }
      | undefined;
  };

  const lastVoiceCallPanelProps = () => {
    const calls = (VoiceCallPanel as unknown as Mock).mock.calls;
    return calls[calls.length - 1]?.[0] as
      | { isAIStreaming: boolean; onStopStream: () => void }
      | undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useConversationMessagesStore.setState({ byConversationId: {} });
    setStoreSelectors({ remote: [], own: [] });
  });

  // PRIVACY. It is tempting to drop the conversation filter while the conversation is
  // still unpersisted ("a fresh chat owns no streams, so there is nothing to confuse it
  // with"), in order to restore the one deliberate property of the old
  // `${pageId}-default` sentinel: two openers of a fresh page shared an id, so each
  // could watch the other's stream. That property WAS a leak. Conversations are private
  // by default and the page channel carries all of them, so an unfiltered surface
  // renders another member's PRIVATE conversation to anyone who opens the page.
  test('given a NOT-YET-PERSISTED conversation, another user\'s stream on this page must NOT render (it may be their private conversation)', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [] });
      }
      return makeErrorResponse();
    });
    setStoreSelectors({
      remote: [{
        messageId: 'msg-someone-elses-private-stream',
        pageId: PAGE_ID,
        isOwn: false,
        conversationId: 'their-private-conversation',
        parts: [{ type: 'text', text: 'secret' }],
      }],
    });
    render(<AiChatView page={page} />);

    await waitForUnpersistedIdentity(PAGE_ID);

    assert({
      given: 'a fresh, unpersisted conversation and another user streaming on the same page',
      should: 'render none of their stream',
      actual: lastChatLayoutProps()?.remoteStreams,
      expected: [],
    });
  });

  // The same unscoping would also mistarget Stop: hitting "New Chat" mid-stream leaves an
  // own stream in the OLD conversation, and an unscoped selector would light up the blank
  // chat's Stop button pointing at it.
  test('given a NOT-YET-PERSISTED conversation and an own stream still running in the OLD one, should not show this chat as streaming', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [] });
      }
      return makeErrorResponse();
    });
    setStoreSelectors({
      own: [{ messageId: 'msg-old-conv', pageId: PAGE_ID, isOwn: true, conversationId: 'the-previous-conversation' }],
    });
    render(<AiChatView page={page} />);

    await waitForUnpersistedIdentity(PAGE_ID);

    assert({
      given: 'an own stream still running in a different (previous) conversation',
      should: 'not light up isStreaming for the blank chat (its Stop would abort the wrong stream)',
      actual: lastChatLayoutProps()?.isStreaming,
      expected: false,
    });
  });

  // AC6. A page channel carries every conversation's streams. Without a conversation
  // filter, a stream running in a DIFFERENT conversation on this page renders into the
  // one on screen — which on its own looks exactly like duplication.
  test('given an own stream in a DIFFERENT conversation on this page, ChatLayout must NOT treat it as this conversation streaming', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-other-conv', pageId: PAGE_ID, isOwn: true, conversationId: 'some-other-conversation' }],
    });
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with an existing conversation',
        should: 'load conversation messages',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    assert({
      given: 'a pending own stream belonging to another conversation on the same page',
      should: 'not light up isStreaming for the conversation on screen',
      actual: lastChatLayoutProps()?.isStreaming,
      expected: false,
    });
  });

  test('given a remote stream in a DIFFERENT conversation on this page, ChatLayout should not receive it', async () => {
    setupHappyInit();
    setStoreSelectors({
      remote: [{ messageId: 'msg-remote-other', pageId: PAGE_ID, isOwn: false, conversationId: 'some-other-conversation', parts: [] }],
    });
    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'init with an existing conversation',
        should: 'load conversation messages',
        actual: wasGetCalled(MESSAGES_URL),
        expected: true,
      });
    });

    assert({
      given: 'a remote stream belonging to another conversation on the same page',
      should: 'not render it into the conversation on screen',
      actual: lastChatLayoutProps()?.remoteStreams,
      expected: [],
    });
  });

  test('given an own stream is pending and useChat status is idle, ChatLayout receives isStreaming=true (so stop button renders after refresh)', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-1', pageId: PAGE_ID, isOwn: true, conversationId: CONV_ID }],
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a pending own stream and useChat status idle',
        should: 'pass effective isStreaming=true to ChatLayout',
        actual: lastChatLayoutProps()?.isStreaming,
        expected: true,
      });
    });
  });

  test('given no own stream and useChat status is idle, ChatLayout receives isStreaming=false (no stop button)', async () => {
    setupHappyInit();

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'no own stream and useChat status idle',
        should: 'pass isStreaming=false to ChatLayout',
        actual: lastChatLayoutProps()?.isStreaming,
        expected: false,
      });
    });
  });

  test('given useChat status is idle but an own stream is pending, calling ChatLayout.onStop calls abortActiveStreamByMessageId with the own stream messageId', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-7', pageId: PAGE_ID, isOwn: true, conversationId: CONV_ID }],
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'AiChatView mounted with own stream',
        should: 'have rendered ChatLayout with onStop',
        actual: typeof lastChatLayoutProps()?.onStop,
        expected: 'function',
      });
    });

    act(() => {
      lastChatLayoutProps()?.onStop();
    });

    assert({
      given: 'isStreaming=false but ownStreams[0] exists, onStop invoked',
      should: 'call abortActiveStreamByMessageId with the own stream messageId',
      actual: mockAbortByMessageId.mock.calls.map((args) => args[0]),
      expected: [{ messageId: 'msg-own-7' }],
    });

    assert({
      given: 'isStreaming=false branch, onStop invoked',
      should: 'NOT call the local useChat stop',
      actual: mockLocalStop.mock.calls.length,
      expected: 0,
    });
  });

  test('given useChat is actively streaming, calling ChatLayout.onStop stops the local fetch AND aborts the server stream by the stable messageId', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-2', pageId: PAGE_ID, isOwn: true, conversationId: CONV_ID }],
    });
    const { useChat } = await import('@ai-sdk/react');
    const useChatMock = useChat as unknown as Mock;
    const streamingStop = vi.fn();
    const idleReturn = {
      messages: [],
      sendMessage: vi.fn(),
      status: 'idle',
      error: undefined,
      regenerate: vi.fn(),
      setMessages: mockSetMessages,
      stop: vi.fn(),
    };
    useChatMock.mockReturnValue({ ...idleReturn, status: 'streaming', stop: streamingStop });

    try {
      render(<AiChatView page={page} />);

      await waitFor(() => {
        assert({
          given: 'AiChatView mounted while streaming',
          should: 'pass isStreaming=true to ChatLayout',
          actual: lastChatLayoutProps()?.isStreaming,
          expected: true,
        });
      });

      act(() => {
        lastChatLayoutProps()?.onStop();
      });

      assert({
        given: 'isStreaming=true, onStop invoked',
        should: 'call the local useChat stop exactly once',
        actual: streamingStop.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'isStreaming=true with a known assistant messageId, onStop invoked',
        should: 'abort the server stream by the stable messageId (authoritative stop)',
        actual: mockAbortByMessageId.mock.calls.map((args) => args[0]),
        expected: [{ messageId: 'msg-own-2' }],
      });
    } finally {
      useChatMock.mockReturnValue(idleReturn);
    }
  });

  test('given voice mode is active and an own stream is pending, VoiceCallPanel receives isAIStreaming=true and a stop handler that aborts by messageId', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-voice', pageId: PAGE_ID, isOwn: true, conversationId: CONV_ID }],
    });
    vi.mocked(useVoiceModeStore).mockImplementation(
      ((selector: (state: { isEnabled: boolean; owner: string; enable: () => void; disable: () => void }) => unknown) =>
        selector({ isEnabled: true, owner: 'ai-page', enable: vi.fn(), disable: vi.fn() })) as unknown as typeof useVoiceModeStore
    );

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'voice mode active with pending own stream',
        should: 'pass isAIStreaming=true to VoiceCallPanel',
        actual: lastVoiceCallPanelProps()?.isAIStreaming,
        expected: true,
      });
    });

    act(() => {
      lastVoiceCallPanelProps()?.onStopStream();
    });

    assert({
      given: 'voice panel stop invoked while own stream pending and idle',
      should: 'abort by messageId',
      actual: mockAbortByMessageId.mock.calls.map((args) => args[0]),
      expected: [{ messageId: 'msg-own-voice' }],
    });
  });
});
