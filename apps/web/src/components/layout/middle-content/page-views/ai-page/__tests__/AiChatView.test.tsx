import { describe, test, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import { assert } from './riteway';

// Hoisted mock instances accessible inside vi.mock factories
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
vi.mock('@/components/ai/chat/layouts', () => ({ ChatLayout: vi.fn(() => null) }));
vi.mock('@/components/ai/chat/input', () => ({ ChatInput: vi.fn(() => null) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('zustand/react/shallow', () => ({ useShallow: vi.fn((fn: unknown) => fn) }));

import AiChatView from '../AiChatView';
import { PageType } from '@pagespace/lib/utils/enums';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

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
