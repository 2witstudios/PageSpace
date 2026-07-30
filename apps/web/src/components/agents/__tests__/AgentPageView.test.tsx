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

const agentPanesState = vi.hoisted(() => ({
  lastOnConversationClosed: null as
    | ((event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void)
    | null,
  // Captured ONCE, on the first render that supplies a callback — models the
  // closure a real in-flight `closeConversationListing` call would hold,
  // unaffected by whatever `onConversationClosed` a LATER render passes
  // (e.g. after the user picks a different conversation while a close DELETE
  // is still pending).
  firstOnConversationClosed: null as
    | ((event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void)
    | null,
}));

vi.mock('../panes/AgentPanes', () => ({
  default: ({
    sessionId,
    initialConversation,
    chatContext,
    isReadOnly,
    onConversationClosed,
  }: {
    sessionId: string;
    initialConversation: { conversationId: string };
    chatContext?: string;
    isReadOnly?: boolean;
    onConversationClosed?: (event: { conversationId: string; next: string | null; nextAgentPageId: string | null }) => void;
  }) => {
    agentPanesState.lastOnConversationClosed = onConversationClosed ?? null;
    if (agentPanesState.firstOnConversationClosed === null) {
      agentPanesState.firstOnConversationClosed = onConversationClosed ?? null;
    }
    return (
      <div data-testid="agent-panes" data-chat-context={chatContext} data-readonly={String(!!isReadOnly)}>
        {sessionId}/{initialConversation.conversationId}
      </div>
    );
  },
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
  // Captured so tests can trigger `onConversationDelete` directly — the real
  // hook fires it when the deleted id is the current conversation; this mock
  // stands in for the hook's own logic, not the callback wiring under test.
  lastOnConversationDelete: null as (() => void) | null,
}));
vi.mock('@/lib/ai/shared/hooks/useConversations', () => ({
  useConversations: (opts: { onConversationDelete?: () => void }) => {
    conversationsState.lastOnConversationDelete = opts.onConversationDelete ?? null;
    return conversationsState.current;
  },
}));

vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: ({ config }: { config: unknown }) => (
    <div data-testid="page-agent-settings-tab" data-has-config={String(config !== null)} />
  ),
  PageAgentHistoryTab: ({
    onSelectConversation,
    onCreateNew,
  }: {
    onSelectConversation: (id: string) => void;
    onCreateNew: () => void;
  }) => (
    <div data-testid="history-tab">
      <button data-testid="history-select-conv-2" onClick={() => onSelectConversation('conv-2')}>
        conv-2
      </button>
      <button data-testid="history-create-new" onClick={onCreateNew}>
        New
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
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';

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
  conversationsState.lastOnConversationDelete = null;
  agentPanesState.lastOnConversationClosed = null;
  agentPanesState.firstOnConversationClosed = null;
  useAgentWorkspaceStore.setState({ workspaces: {} });
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

  it('a NON-session user gets the plain chat even for a session-bound conversation (review M2)', async () => {
    // A shared session-bound thread can be a non-admin's most-recent
    // conversation; a grid whose every affordance 403s — except the
    // destructive last-pane-close — is worse than the chat they can use.
    authState.current = { user: { id: 'user-2', role: 'user' } };
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));
    expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument();
  });

  it('the grid receives the read-only verdict (review M2)', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/permissions/check')) return jsonResponse({ canEdit: false });
      return jsonResponse({});
    });
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-readonly', 'true'));
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

  describe('deleting the current conversation (issue #2263, finding 4)', () => {
    it('when session-bound, mints the replacement INTO that session — never a new one', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      conversationsState.lastOnConversationDelete?.();

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: 'ses-1' }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-2'));
    });

    it('prunes the pane that was showing the deleted conversation, wherever it lived in the grid', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      // A split grid where the deleted conversation is NOT the active pane —
      // pruning must target the pane actually showing it, not "the active one".
      useAgentWorkspaceStore.getState().ensureWorkspace('ses-1', {
        kind: 'chat',
        name: 'Conversation',
        targetId: 'conv-1',
        agentPageId: 'agent-1',
      });
      const originalPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].activePaneId;
      useAgentWorkspaceStore.getState().splitRight('ses-1', originalPaneId);
      useAgentWorkspaceStore.getState().selectPane('ses-1', originalPaneId);

      conversationsState.lastOnConversationDelete?.();

      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === originalPaneId);
        expect(pane?.scope?.targetId).toBe('conv-2');
      });
    });

    it('when NOT session-bound, falls back to the plain new-conversation path unaffected', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: null });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));

      conversationsState.lastOnConversationDelete?.();

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: null }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-2'));
    });

    it('the History tab "New" button is unaffected — it always spawns a fresh session, never reuses', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-3', sessionId: 'ses-new' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      await userEvent.click(screen.getByRole('tab', { name: /history/i }));
      await userEvent.click(await screen.findByTestId('history-create-new'));

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: null }),
        ),
      );
    });
  });

  describe('onConversationClosed — a session-grid listing close, not a history delete', () => {
    it("mints a fresh replacement for THIS agent when the grid closed current's listing", async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      agentPanesState.lastOnConversationClosed?.({ conversationId: 'conv-1', next: null, nextAgentPageId: null });

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: 'ses-1' }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-2'));
    });

    it('ignores a close for a conversation that is not the currently tracked one', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      agentPanesState.lastOnConversationClosed?.({ conversationId: 'conv-other', next: null, nextAgentPageId: null });

      expect(mockCreatePageConversation).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1');
    });

    it('a stale close (captured before the user selected a different thread) does not mint an unwanted replacement', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      conversationsState.current.conversations = [{ id: 'conv-2', sessionId: 'ses-1' }];
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
      const staleCallback = agentPanesState.firstOnConversationClosed;

      // The user selects a different history thread WHILE a close DELETE for
      // conv-1 is still in flight — `current` moves on before that request's
      // own callback (captured on the earlier render) ever fires.
      await userEvent.click(screen.getByRole('tab', { name: /history/i }));
      fireEvent.click(await screen.findByTestId('history-select-conv-2'));
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2'));

      staleCallback?.({ conversationId: 'conv-1', next: null, nextAgentPageId: null });

      // 'conv-1' no longer matches the CURRENT tracked conversation
      // ('conv-2'), so the stale callback must be a no-op — not mint an
      // unnecessary replacement and not disturb the user's newer selection.
      expect(mockCreatePageConversation).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2');
    });
  });
});
