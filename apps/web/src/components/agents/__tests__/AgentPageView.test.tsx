/**
 * AgentPageView Component Tests — Phase 6.
 *
 * The page-level scaffolding AiChatView used to own (which conversation is on
 * screen, read-only gating, the history picker, settings/integrations/
 * webhooks) now lives here, thin, on top of `AgentView`. All IO hooks and the
 * re-hosted settings/integrations/webhooks/history components are mocked;
 * this suite covers AgentPageView's own wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TreePage } from '@/hooks/usePageTree';

const resolvedConversation = vi.hoisted(() => ({ current: { conversationId: null as string | null, isLoading: true } }));
vi.mock('../useResolvedConversation', () => ({
  useResolvedConversation: () => resolvedConversation.current,
}));

vi.mock('../AgentView', () => ({
  default: ({
    conversationId,
    isReadOnly,
    headerExtra,
    settingsTab,
  }: {
    conversationId: string;
    isReadOnly?: boolean;
    headerExtra?: React.ReactNode;
    settingsTab?: React.ReactNode;
  }) => (
    <div data-testid="agent-view" data-readonly={String(!!isReadOnly)}>
      <div data-testid="agent-view-conversation">{conversationId}</div>
      <div data-testid="agent-view-header-extra">{headerExtra}</div>
      <div data-testid="agent-view-settings-tab">{settingsTab}</div>
    </div>
  ),
}));

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mockFetchWithAuth }));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));

vi.mock('@/hooks/conversationMessagesActions', () => ({
  conversationMessagesActions: { seedConversation: vi.fn() },
}));

vi.mock('@/lib/ai/shared/hooks/useProviderSettings', () => ({
  useProviderSettings: () => ({
    selectedProvider: 'anthropic',
    setSelectedProvider: vi.fn(),
    selectedModel: 'claude-sonnet-5',
    setSelectedModel: vi.fn(),
    isProviderConfigured: () => true,
  }),
}));

const conversationsState = vi.hoisted(() => ({
  current: {
    conversations: [] as Array<{ id: string }>,
    isLoading: false,
    createConversation: vi.fn(async () => 'new-conv'),
    deleteConversation: vi.fn(async () => {}),
  },
}));
vi.mock('@/lib/ai/shared/hooks/useConversations', () => ({
  useConversations: () => conversationsState.current,
}));

vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: () => <div data-testid="page-agent-settings-tab" />,
  PageAgentHistoryTab: ({
    onSelectConversation,
  }: {
    onSelectConversation: (id: string) => void;
  }) => (
    <button data-testid="history-select-conv-2" onClick={() => onSelectConversation('conv-2')}>
      conv-2
    </button>
  ),
}));

vi.mock('@/components/ai/page-agents/AgentIntegrationsPanel', () => ({
  AgentIntegrationsPanel: () => <div data-testid="agent-integrations-panel" />,
}));

vi.mock('@/components/shared/PageWebhooksDialog', () => ({
  PageWebhooksDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="webhooks-dialog" /> : null),
}));

import AgentPageView from '../AgentPageView';

function pageFixture(): TreePage {
  return {
    id: 'agent-1',
    title: 'My Agent',
    type: 'AI_CHAT',
    driveId: 'drive-1',
    children: [],
    aiChat: null,
    messages: [],
  } as unknown as TreePage;
}

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConversation.current = { conversationId: null, isLoading: true };
  conversationsState.current = {
    conversations: [],
    isLoading: false,
    createConversation: vi.fn(async () => 'new-conv'),
    deleteConversation: vi.fn(async () => {}),
  };
  mockFetchWithAuth.mockImplementation(async (url: string) => {
    if (url.endsWith('/permissions/check')) return jsonResponse({ canEdit: true });
    if (url.endsWith('/agent-config')) return jsonResponse({ systemPrompt: '', enabledTools: [], availableTools: [] });
    return jsonResponse({});
  });
});

describe('AgentPageView', () => {
  it('shows a loading state until the conversation resolves', async () => {
    render(<AgentPageView page={pageFixture()} />);
    expect(screen.getByTestId('agent-page-view-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-view')).not.toBeInTheDocument();
    // Let the permission-check/agent-config fetch effects settle before the test ends.
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('renders AgentView once the conversation resolves, with the resolved id', async () => {
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-1'));
  });

  it('marks AgentView read-only when the permission check says canEdit: false', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/permissions/check')) return jsonResponse({ canEdit: false });
      return jsonResponse({});
    });
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };

    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-view')).toHaveAttribute('data-readonly', 'true'));
  });

  it('passes the settings tab content (settings, integrations, webhooks trigger) through to AgentView', async () => {
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-1'));

    expect(screen.getByTestId('page-agent-settings-tab')).toBeInTheDocument();
    expect(screen.getByTestId('agent-integrations-panel')).toBeInTheDocument();
    expect(screen.getByText('Webhooks')).toBeInTheDocument();
  });

  it('opens the webhooks dialog from the settings tab', async () => {
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-1'));

    fireEvent.click(screen.getByText('Webhooks'));
    expect(screen.getByTestId('webhooks-dialog')).toBeInTheDocument();
  });

  it('cross-links to the Agents console for this exact agent + conversation', async () => {
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-1'));

    expect(screen.getByText('Open in Agents')).toHaveAttribute(
      'href',
      '/dashboard/drive-1/agents?agent=agent-1&c=conv-1',
    );
  });

  it('selecting a conversation from the history picker (headerExtra) switches AgentView to it', async () => {
    resolvedConversation.current = { conversationId: 'conv-1', isLoading: false };
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-1'));

    fireEvent.click(screen.getByLabelText('Conversation history'));
    fireEvent.click(await screen.findByTestId('history-select-conv-2'));

    await waitFor(() => expect(screen.getByTestId('agent-view-conversation')).toHaveTextContent('conv-2'));
  });
});
