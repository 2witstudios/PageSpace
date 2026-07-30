/**
 * AgentPageView — the restored AiChatView shape.
 *
 * The properties worth pinning: **Chat | History | Settings are real tabs**
 * (History full-height, never a popover), **Save lives in the header row**
 * (settings tab active), and the Chat tab's TWO renderings — the PANE GRID for
 * a session-bound conversation, the plain chat for a pre-session one. All IO
 * hooks and the re-hosted settings/integrations/webhooks/history components
 * are mocked; this suite covers the page's own wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TreePage } from '@/hooks/usePageTree';
import type { ResolvedConversation } from '../useResolvedConversation';

const resolvedConversation = vi.hoisted(() => ({
  current: { resolved: null as ResolvedConversation | null, isLoading: true },
}));
const mockCreatePageConversation = vi.hoisted(() => vi.fn());
vi.mock('../useResolvedConversation', () => ({
  useResolvedConversation: () => resolvedConversation.current,
  createPageConversation: (...args: unknown[]) => mockCreatePageConversation(...args),
}));

vi.mock('../useResolvedAgent', () => ({
  useResolvedAgent: () => ({
    agent: { id: 'agent-1', title: 'My Agent', driveId: 'drive-1', driveName: 'Drive' },
    isLoading: false,
    error: undefined,
    retry: vi.fn(),
  }),
}));

vi.mock('../chat/SessionChat', () => ({
  default: ({ conversationId, isReadOnly }: { conversationId: string; isReadOnly?: boolean }) => (
    <div data-testid="plain-chat" data-readonly={String(!!isReadOnly)}>
      {conversationId}
    </div>
  ),
}));

vi.mock('../panes/AgentPanes', () => ({
  default: ({
    sessionId,
    initialConversation,
    chatContext,
  }: {
    sessionId: string;
    initialConversation: { conversationId: string };
    chatContext?: string;
  }) => (
    <div data-testid="agent-panes" data-chat-context={chatContext}>
      {sessionId}/{initialConversation.conversationId}
    </div>
  ),
}));

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: vi.fn(),
}));

const authState = vi.hoisted(() => ({ current: { user: { id: 'user-1', role: 'admin' } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => authState.current }));

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
    conversations: [] as Array<{ id: string; sessionId: string | null }>,
    isLoading: false,
    deleteConversation: vi.fn(async () => {}),
    refreshConversations: vi.fn(),
  },
}));
vi.mock('@/lib/ai/shared/hooks/useConversations', () => ({
  useConversations: () => conversationsState.current,
}));

vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: ({ config }: { config: unknown }) => (
    <div data-testid="page-agent-settings-tab" data-has-config={String(config !== null)} />
  ),
  PageAgentHistoryTab: ({
    onSelectConversation,
  }: {
    onSelectConversation: (id: string) => void;
  }) => (
    <div data-testid="history-tab">
      <button data-testid="history-select-conv-2" onClick={() => onSelectConversation('conv-2')}>
        conv-2
      </button>
    </div>
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

const resolveTo = (resolved: ResolvedConversation) => {
  resolvedConversation.current = { resolved, isLoading: false };
};

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConversation.current = { resolved: null, isLoading: true };
  authState.current = { user: { id: 'user-1', role: 'admin' } };
  conversationsState.current = {
    conversations: [],
    isLoading: false,
    deleteConversation: vi.fn(async () => {}),
    refreshConversations: vi.fn(),
  };
  mockFetchWithAuth.mockImplementation(async (url: string) => {
    if (url.endsWith('/permissions/check')) return jsonResponse({ canEdit: true });
    if (url.endsWith('/agent-config'))
      return jsonResponse({ systemPrompt: '', enabledTools: [], availableTools: [] });
    return jsonResponse({});
  });
});

describe('AgentPageView', () => {
  it('shows a loading state until the conversation resolves', async () => {
    render(<AgentPageView page={pageFixture()} />);
    expect(screen.getByTestId('agent-page-view-loading')).toBeInTheDocument();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('renders Chat | History | Settings as real tabs', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    expect(screen.getByRole('tab', { name: /chat/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /settings/i })).toBeInTheDocument();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('a session-bound conversation renders the PANE GRID with the page renderer', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1'));
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-chat-context', 'page');
    expect(screen.queryByTestId('plain-chat')).not.toBeInTheDocument();
  });

  it('a pre-session conversation renders the plain chat — no grid, no splits', async () => {
    resolveTo({ conversationId: 'conv-old', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-old'));
    expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument();
  });

  it('marks the chat read-only when the permission check says canEdit: false', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/permissions/check')) return jsonResponse({ canEdit: false });
      return jsonResponse({});
    });
    resolveTo({ conversationId: 'conv-1', sessionId: null });

    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveAttribute('data-readonly', 'true'));
  });

  it('History is a full-height TAB, not a popover', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await userEvent.click(screen.getByRole('tab', { name: /history/i }));

    expect(await screen.findByTestId('history-tab')).toBeInTheDocument();
    // The one structural fact that made the popover broken: the tab content is
    // a flexing region the h-full component can resolve against.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('selecting a conversation from History opens it in Chat, carrying its session', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    conversationsState.current.conversations = [{ id: 'conv-2', sessionId: 'ses-2' }];
    render(<AgentPageView page={pageFixture()} />);

    await userEvent.click(screen.getByRole('tab', { name: /history/i }));
    fireEvent.click(await screen.findByTestId('history-select-conv-2'));

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-2/conv-2'));
  });

  it('Save Settings is pinned in the header row while the settings tab is active', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    expect(screen.queryByText('Save Settings')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /settings/i }));

    expect(await screen.findByText('Save Settings')).toBeInTheDocument();
    expect(screen.getByTestId('page-agent-settings-tab')).toBeInTheDocument();
    expect(screen.getByTestId('agent-integrations-panel')).toBeInTheDocument();
  });

  it('loads the agent config so the Settings tab has data, not an eternal spinner', async () => {
    // The rewrite once dropped this fetch entirely — PageAgentSettingsTab
    // shows its loading state until config arrives, so a page that never
    // fetches it has a Settings tab that never works (codex review, P1).
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/pages/agent-1/agent-config',
        expect.objectContaining({ signal: expect.anything() }),
      ),
    );
    await userEvent.click(screen.getByRole('tab', { name: /settings/i }));
    await waitFor(() =>
      expect(screen.getByTestId('page-agent-settings-tab')).toHaveAttribute('data-has-config', 'true'),
    );
  });

  it('opens the webhooks dialog from the icon-only header button', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    fireEvent.click(screen.getByLabelText('Incoming Webhooks'));
    expect(screen.getByTestId('webhooks-dialog')).toBeInTheDocument();
  });

  it('cross-links to the Agents console, carrying the session when bound', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    expect(screen.getByText('Open in Agents')).toHaveAttribute(
      'href',
      '/dashboard/drive-1/agents?session=ses-1&c=conv-1&agent=agent-1',
    );
  });

  it('hides the console cross-link from non-session users — the console would refuse them', async () => {
    authState.current = { user: { id: 'user-2', role: 'user' } };
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    expect(screen.queryByText('Open in Agents')).not.toBeInTheDocument();
  });

  it('contains NONE of the removed chrome: no status chip, no Add shell, no history popover', async () => {
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(screen.queryByTestId('sandbox-status-chip')).not.toBeInTheDocument();
    expect(screen.queryByText(/add shell/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Conversation history')).not.toBeInTheDocument();
  });
});
