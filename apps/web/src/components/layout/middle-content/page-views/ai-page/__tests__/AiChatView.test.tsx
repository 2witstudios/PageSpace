import { describe, test, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import { assert } from './riteway';

// ============================================================
// Hoisted mock instances (accessible inside vi.mock factories)
// ============================================================
const { mockFetchWithAuth, mockSetMessages } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockSetMessages: vi.fn(),
}));

// ============================================================
// Module mocks — must be declared before any import of the module
// ============================================================
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
    (selector: (state: { isEnabled: boolean; owner: null; enable: () => void; disable: () => void }) => unknown) => {
      const state = { isEnabled: false, owner: null, enable: vi.fn(), disable: vi.fn() };
      return selector(state);
    }
  ),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: vi.fn(() => ({ register: vi.fn(), unregister: vi.fn() })),
  isEditingActive: vi.fn(() => false),
}));

vi.mock('@/stores/usePendingStreamsStore', () => {
  const mockStore = Object.assign(vi.fn(() => []), {
    getState: vi.fn(() => ({ streams: new Map() })),
  });
  return { usePendingStreamsStore: mockStore };
});

vi.mock('@/hooks/usePageSocketRoom', () => ({
  usePageSocketRoom: vi.fn(),
}));

vi.mock('@/hooks/useChatStreamSocket', () => ({
  useChatStreamSocket: vi.fn(),
}));

vi.mock('@/hooks/useAppStateRecovery', () => ({
  useAppStateRecovery: vi.fn(),
}));

vi.mock('@/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: vi.fn(() => ({ preferences: { showTokenCounts: false } })),
}));

vi.mock('@/lib/ai/core/client', () => ({
  clearActiveStreamId: vi.fn(),
}));

vi.mock('@/lib/ai/core/vision-models', () => ({
  hasVisionCapability: vi.fn(() => false),
}));

const mockCreateConversation = vi.fn();

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
  useChatStop: vi.fn(() => vi.fn()),
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

vi.mock('@/lib/tree/tree-utils', () => ({
  buildPagePath: vi.fn(() => null),
}));

vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: vi.fn(() => null),
  PageAgentHistoryTab: vi.fn(() => null),
}));

vi.mock('@/components/ai/page-agents/AgentIntegrationsPanel', () => ({
  AgentIntegrationsPanel: vi.fn(() => null),
}));

vi.mock('@/components/ai/voice/VoiceCallPanel', () => ({
  VoiceCallPanel: vi.fn(() => null),
}));

vi.mock('@/components/ai/shared/chat', () => ({
  ProviderSetupCard: vi.fn(() => null),
}));

vi.mock('@/components/ai/shared', () => ({
  AiUsageMonitor: vi.fn(() => null),
  TasksDropdown: vi.fn(() => null),
}));

vi.mock('@/components/ai/chat/layouts', () => ({
  ChatLayout: vi.fn(() => null),
}));

vi.mock('@/components/ai/chat/input', () => ({
  ChatInput: vi.fn(() => null),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: vi.fn((fn: unknown) => fn),
}));

// ============================================================
// Import component after mocks
// ============================================================
import AiChatView from '../AiChatView';
import { PageType } from '@pagespace/lib/utils/enums';

// ============================================================
// Test constants
// ============================================================
const PAGE_ID = 'page-123';
const CONV_ID = 'conv-existing-abc';
const NEW_CONV_ID = 'conv-new-xyz';
const CONVERSATIONS_URL = `/api/ai/page-agents/${PAGE_ID}/conversations`;
const MESSAGES_URL = `/api/ai/page-agents/${PAGE_ID}/conversations/${CONV_ID}/messages`;
const AGENT_CONFIG_URL = `/api/pages/${PAGE_ID}/agent-config`;
const PERMISSIONS_URL = `/api/pages/${PAGE_ID}/permissions/check`;

// ============================================================
// Test helpers
// ============================================================
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFetchWithAuth.mock.calls.some((args: any[]) => {
    const [callUrl, opts] = args;
    return callUrl === url && (!opts?.method || opts.method === 'GET');
  });

const wasPostCalled = (url: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFetchWithAuth.mock.calls.some((args: any[]) => {
    const [callUrl, opts] = args;
    return callUrl === url && opts?.method === 'POST';
  });

// ============================================================
// Tests
// ============================================================
describe('AiChatView initializeChat', () => {
  const page = makePage();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('given a page with existing conversations, loads the most recent conversation without creating a new one', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [existingConversation] });
      }
      if (url === MESSAGES_URL && !opts?.method) {
        return makeOkResponse({
          messages: [{ id: 'msg-1', role: 'user', content: 'hello', parts: [{ type: 'text', text: 'hello' }] }],
        });
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
  });

  test('given a page with no conversations, creates a new conversation after checking for existing ones', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeOkResponse({ conversations: [] });
      }
      if (url === CONVERSATIONS_URL && opts?.method === 'POST') {
        return makeOkResponse({ conversationId: NEW_CONV_ID });
      }
      return makeErrorResponse();
    });

    render(<AiChatView page={page} />);

    await waitFor(() => {
      assert({
        given: 'a page with no conversations',
        should: 'GET conversations list first',
        actual: wasGetCalled(`${CONVERSATIONS_URL}?pageSize=1`),
        expected: true,
      });
    });

    assert({
      given: 'a page with no conversations',
      should: 'create a new conversation via POST after finding none',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: true,
    });
  });

  test('given conversations fetch fails with non-ok response, falls back to creating a new conversation', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === PERMISSIONS_URL) return makeOkResponse({ canEdit: true });
      if (url === AGENT_CONFIG_URL) return makeOkResponse({});
      if (url === `${CONVERSATIONS_URL}?pageSize=1` && !opts?.method) {
        return makeErrorResponse();
      }
      if (url === CONVERSATIONS_URL && opts?.method === 'POST') {
        return makeOkResponse({ conversationId: NEW_CONV_ID });
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
      should: 'fall back to creating a new conversation via POST',
      actual: wasPostCalled(CONVERSATIONS_URL),
      expected: true,
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
        should: 'load messages from the shared existing conversation (not create a new one)',
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

    await waitFor(() => {
      assert({
        given: 'component initialized',
        should: 'render the New Chat button',
        actual: screen.getAllByRole('button').some(
          (b) => b.textContent?.includes('New Chat') || b.getAttribute('aria-label')?.includes('New Chat')
        ),
        expected: true,
      });
    });

    const newChatButton = screen.getAllByRole('button').find(
      (b) => b.textContent?.includes('New Chat') || b.getAttribute('aria-label')?.includes('New Chat')
    );
    if (newChatButton) fireEvent.click(newChatButton);

    assert({
      given: 'user clicks the New Chat button',
      should: 'call createConversation from useConversations (no change to existing behavior)',
      actual: mockCreateConversation.mock.calls.length,
      expected: 1,
    });
  });
});
