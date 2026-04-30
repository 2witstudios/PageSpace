import { describe, test, vi, beforeEach, type Mock } from 'vitest';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react';
import { assert } from './riteway';

// Hoisted mock instances accessible inside vi.mock factories
const { mockFetchWithAuth, mockSetMessages, mockLocalStop, mockAbortByMessageId } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockSetMessages: vi.fn(),
  mockLocalStop: vi.fn(),
  mockAbortByMessageId: vi.fn(),
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

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn(() => ({
    messages: [],
    sendMessage: vi.fn(),
    status: 'idle',
    error: undefined,
    regenerate: vi.fn(),
    setMessages: mockSetMessages,
    stop: vi.fn(),
  })),
}));

vi.mock('swr', () => ({
  default: vi.fn(() => ({ data: undefined, error: undefined })),
  useSWRConfig: vi.fn(() => ({ cache: { get: vi.fn(() => undefined) } })),
}));

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: vi.fn((selector: (state: { drives: unknown[] }) => unknown) =>
    selector({ drives: [] })
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-1', name: 'Test User' } })),
}));

vi.mock('@/stores/useAssistantSettingsStore', () => ({
  useAssistantSettingsStore: vi.fn((selector: (state: { webSearchEnabled: boolean }) => unknown) =>
    selector({ webSearchEnabled: false })
  ),
}));

vi.mock('@/stores/useVoiceModeStore', () => ({
  useVoiceModeStore: vi.fn(
    (selector: (state: { isEnabled: boolean; owner: null; enable: () => void; disable: () => void }) => unknown) =>
      selector({ isEnabled: false, owner: null, enable: vi.fn(), disable: vi.fn() })
  ),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: vi.fn(() => ({ register: vi.fn(), unregister: vi.fn() })),
  isEditingActive: vi.fn(() => false),
}));

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: Object.assign(vi.fn(() => []), {
    getState: vi.fn(() => ({ streams: new Map() })),
  }),
}));

vi.mock('@/hooks/usePageSocketRoom', () => ({ usePageSocketRoom: vi.fn() }));
vi.mock('@/hooks/useChatStreamSocket', () => ({ useChatStreamSocket: vi.fn() }));
vi.mock('@/hooks/useAppStateRecovery', () => ({ useAppStateRecovery: vi.fn() }));

vi.mock('@/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: vi.fn(() => ({ preferences: { showTokenCounts: false } })),
}));

vi.mock('@/lib/ai/core/client', () => ({ clearActiveStreamId: vi.fn() }));
vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStreamByMessageId: mockAbortByMessageId,
}));
vi.mock('@/lib/ai/core/vision-models', () => ({ hasVisionCapability: vi.fn(() => false) }));

const { mockCreateConversation } = vi.hoisted(() => ({
  mockCreateConversation: vi.fn(),
}));

vi.mock('@/lib/ai/shared', () => ({
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
  useConversations: vi.fn(() => ({
    conversations: [],
    isLoading: false,
    loadConversation: vi.fn(),
    createConversation: mockCreateConversation,
    deleteConversation: vi.fn(),
  })),
  useChatTransport: vi.fn(() => ({})),
  useStreamingRegistration: vi.fn(),
  useChatStop: vi.fn(() => mockLocalStop),
  useSendHandoff: vi.fn(() => ({ wrapSend: vi.fn((cb: () => void) => cb()) })),
}));

vi.mock('@/lib/ai/shared/hooks/useImageAttachments', () => ({
  useImageAttachments: vi.fn(() => ({
    attachments: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    getFilesForSend: vi.fn(() => []),
  })),
}));

vi.mock('@/lib/tree/tree-utils', () => ({ buildPagePath: vi.fn(() => null) }));
vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: vi.fn(() => null),
  PageAgentHistoryTab: vi.fn(() => null),
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

import AiChatView from '../AiChatView';
import { PageType } from '@pagespace/lib/utils/enums';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useChatStreamSocket } from '@/hooks/useChatStreamSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { ChatLayout } from '@/components/ai/chat/layouts';
import { VoiceCallPanel } from '@/components/ai/voice/VoiceCallPanel';
import { useVoiceModeStore } from '@/stores/useVoiceModeStore';

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

describe('AiChatView initializeChat', () => {
  const page = makePage();

  beforeEach(() => {
    vi.clearAllMocks();
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

    assert({
      given: 'a page with existing conversations',
      should: 'apply the fetched messages to chat state',
      actual: mockSetMessages.mock.calls.some(
        (args) => JSON.stringify(args[0]) === JSON.stringify(testMessages)
      ),
      expected: true,
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
});

describe('AiChatView late-joiner conversation sync', () => {
  const page = makePage();
  const MESSAGE_ID = 'msg-late-joiner';
  const REAL_CONV_ID = 'real-conv-id';

  beforeEach(() => {
    vi.clearAllMocks();
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
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChatStreamSocket).mockImplementation((_pageId, _userId, cb) => {
      capturedCallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI response', conversationId: REAL_CONV_ID }]]),
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
        given: 'stream.conversationId matches the persisted conversation while holding page-scoped default',
        should: 'append the completed AI message',
        actual: mockSetMessages.mock.calls.some((args) => typeof args[0] === 'function'),
        expected: true,
      });
    });
  });

  test('given fireComplete fires with stream.conversationId that does NOT match the persisted conversation, should NOT append the message', async () => {
    let capturedCallback: ((messageId: string) => void) | undefined;
    vi.mocked(useChatStreamSocket).mockImplementation((_pageId, _userId, cb) => {
      capturedCallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI response', conversationId: REAL_CONV_ID }]]),
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
    vi.mocked(useChatStreamSocket).mockImplementation((_pageId, _userId, cb) => {
      capturedCallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI response', conversationId: REAL_CONV_ID }]]),
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
    vi.mocked(useChatStreamSocket).mockImplementation((_pageId, _userId, cb) => {
      capturedCallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI response', conversationId: REAL_CONV_ID }]]),
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
    vi.mocked(useChatStreamSocket).mockImplementation((_pageId, _userId, cb) => {
      capturedCallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI response', conversationId: REAL_CONV_ID }]]),
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
    vi.mocked(useChatStreamSocket).mockImplementation((pageId, _userId, cb) => {
      if (pageId === PAGE_ID) capturedPageACallback = cb;
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

    (usePendingStreamsStore as unknown as { getState: Mock }).getState.mockReturnValue({
      streams: new Map([[MESSAGE_ID, { text: 'AI from page A', conversationId: REAL_CONV_ID }]]),
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
});

describe('AiChatView stop button for reconnected own streams', () => {
  const page = makePage();

  type StoreState = {
    streams: Map<string, unknown>;
    getRemotePageStreams: (pageId: string) => unknown[];
    getOwnStreams: (pageId: string) => Array<{ messageId: string; pageId: string; isOwn: true }>;
  };

  const setStoreSelectors = ({
    remote = [],
    own = [],
  }: {
    remote?: unknown[];
    own?: Array<{ messageId: string; pageId: string; isOwn: true }>;
  }) => {
    const state: StoreState = {
      streams: new Map(),
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
    setStoreSelectors({ remote: [], own: [] });
  });

  test('given an own stream is pending and useChat status is idle, ChatLayout receives isStreaming=true (so stop button renders after refresh)', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-1', pageId: PAGE_ID, isOwn: true }],
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
      own: [{ messageId: 'msg-own-7', pageId: PAGE_ID, isOwn: true }],
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

  test('given useChat is actively streaming, calling ChatLayout.onStop calls the local useChat stop and not the remote abort', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-2', pageId: PAGE_ID, isOwn: true }],
    });
    const { useChat } = await import('@ai-sdk/react');
    const useChatMock = useChat as unknown as Mock;
    const idleReturn = {
      messages: [],
      sendMessage: vi.fn(),
      status: 'idle',
      error: undefined,
      regenerate: vi.fn(),
      setMessages: mockSetMessages,
      stop: vi.fn(),
    };
    useChatMock.mockReturnValue({ ...idleReturn, status: 'streaming' });

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
        should: 'call local stop exactly once',
        actual: mockLocalStop.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'isStreaming=true, onStop invoked',
        should: 'NOT call abortActiveStreamByMessageId (avoid double-stop)',
        actual: mockAbortByMessageId.mock.calls.length,
        expected: 0,
      });
    } finally {
      useChatMock.mockReturnValue(idleReturn);
    }
  });

  test('given voice mode is active and an own stream is pending, VoiceCallPanel receives isAIStreaming=true and a stop handler that aborts by messageId', async () => {
    setupHappyInit();
    setStoreSelectors({
      own: [{ messageId: 'msg-own-voice', pageId: PAGE_ID, isOwn: true }],
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
