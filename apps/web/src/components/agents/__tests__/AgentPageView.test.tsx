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
import { useSearchParams } from 'next/navigation';
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

const mockMutate = vi.hoisted(() => vi.fn());
// Defaults to "not yet loaded" (`data: undefined`) so `panesDriveId` falls
// back to `page.driveId` — identical to every pre-existing test's behavior.
// One dedicated test below overrides this to pin the cross-drive-session
// correction (the session's OWN driveId, not the hosted agent page's). Shape
// matches `useSessionRecord`'s raw session-record result, not a pre-coalesced
// driveId.
type MockSessionRecordData = { session: { driveId: string | null } | null } | undefined;
const mockUseSWR = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ data: undefined as MockSessionRecordData })));
vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
  mutate: (...args: unknown[]) => mockMutate(...args),
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
    driveId,
    initialConversation,
    chatContext,
    isReadOnly,
    onConversationClosed,
  }: {
    sessionId: string;
    driveId: string | null;
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
      <div
        data-testid="agent-panes"
        data-chat-context={chatContext}
        data-readonly={String(!!isReadOnly)}
        data-drive-id={driveId ?? ''}
      >
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
  lastOnConversationDelete: null as ((conversationId: string) => void) | null,
}));
vi.mock('@/lib/ai/shared/hooks/useConversations', () => ({
  useConversations: (opts: { onConversationDelete?: (conversationId: string) => void }) => {
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
  // `vi.clearAllMocks()` clears call/result history but NOT a persistent
  // `mockReturnValue` override — re-establish the documented default here so
  // one test's override (the global-assistant-session test below) can never
  // leak into whichever test happens to run next.
  mockUseSWR.mockReturnValue({ data: undefined });
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
    // Defaults to the agent page's own drive while the session record is
    // unresolved — correct for the overwhelming common case.
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', 'drive-1');
    expect(screen.queryByTestId('plain-chat')).not.toBeInTheDocument();
  });

  it('a conversation whose SESSION is a global-assistant session passes the SESSION drive (null), not the agent page drive', async () => {
    // Reachable now that a global session can host any accessible agent's
    // conversation (create-conversation-in-session.ts): this agent page's
    // most-recent conversation can be bound to a global session. AgentPanes
    // must scope to the session's OWN drive (null), never `page.driveId` —
    // otherwise `agentSessionsKey`/the picker look in the wrong workspace.
    // The raw session-record shape `useSessionRecord` resolves to (not a
    // pre-coalesced driveId) — a RESOLVED global session, session.driveId null.
    mockUseSWR.mockReturnValue({ data: { session: { driveId: null } } });
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-global' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-global/conv-1'));
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', '');
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

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: 'ses-1' }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-2'));
    });

    it('inserts the replacement into the sessions-listing cache LOCALLY, not just a background revalidate', async () => {
      // A background revalidate alone leaves a real window: closing the
      // replacement pane before that GET resolves (or it failing outright)
      // would still read the brand-new row as absent from `AgentPanes`' own
      // cache and take the pure layout-close path instead of DELETE — or
      // even offer to end the session on a grid whose only cached listing is
      // stale (the same class of bug `handlePickAgent` already guards
      // against via its own local `recordMintedConversation`, not merely a
      // revalidate — caught in review).
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('/api/agent-sessions?driveId=drive-1', expect.any(Function), { revalidate: false }));
      const [, updater] = mockMutate.mock.calls.find(([key]) => key === '/api/agent-sessions?driveId=drive-1')!;
      const updated = (updater as (current: unknown) => unknown)({
        sessions: [{ sessionId: 'ses-1', conversations: [] }],
      });
      expect(updated).toEqual({
        sessions: [{ sessionId: 'ses-1', conversations: [{ conversationId: 'conv-2', agentPageId: 'agent-1', lastMessageAt: null }] }],
      });
    });

    it('also revalidates the sessions-listing cache after minting the replacement, so a fast re-close sees the new row', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() => expect(mockMutate.mock.calls.some(([key]) => typeof key === 'function')).toBe(true));
      const predicate = mockMutate.mock.calls.find(([key]) => typeof key === 'function')![0] as (
        key: unknown,
      ) => boolean;
      expect(predicate('/api/agent-sessions?driveId=drive-1')).toBe(true);
      expect(predicate('/api/pages/agent-1')).toBe(false);
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

      conversationsState.lastOnConversationDelete?.('conv-1');

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

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: null }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-2'));
    });

    it('a session-less mint that comes back session-bound switches to the pane grid with the REAL new session, not null', async () => {
      // The stale conversation had no session (sessionId: null), so the mint
      // call passes sessionId: null too — but createPageConversation is free
      // to spawn a brand-new session on that path (canUseSessions), and the
      // override must reflect what it actually returned, not the pre-mint
      // guess (a stale-outer-variable regression caught in adversarial
      // review after the round-2 async-gap fix).
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-new' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: null }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-new'));
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2'));
      expect(screen.queryByTestId('plain-chat')).not.toBeInTheDocument();
    });

    it('a stale History delete (captured before the user selected a different thread) does not mint an unwanted replacement', async () => {
      // `useConversations` binds `onConversationDelete` to whichever id WAS
      // current at click time (conv-1) and fires it whenever that DELETE
      // resolves, however late — even after the user has already switched to
      // a different thread. The callback must recover using conv-1, not
      // whatever `current` has since become, or it mints a replacement into
      // the WRONG (newly-current) conversation's session (caught in review).
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      conversationsState.current.conversations = [{ id: 'conv-2', sessionId: 'ses-1' }];
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      // The user selects a different history thread WHILE conv-1's own
      // DELETE is still in flight.
      await userEvent.click(screen.getByRole('tab', { name: /history/i }));
      fireEvent.click(await screen.findByTestId('history-select-conv-2'));
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2'));

      conversationsState.lastOnConversationDelete?.('conv-1');

      // 'conv-1' no longer matches the CURRENT tracked conversation
      // ('conv-2'), so the late-arriving delete must be a no-op.
      expect(mockCreatePageConversation).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2');
    });

    it('reports an error rather than crashing when the replacement mint itself fails', async () => {
      // The listing close already succeeded server-side by the time this
      // runs — only the replacement POST fails (network, lost permission, a
      // concurrent cap fill). Without a catch this was an unhandled
      // rejection (caught in review).
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockRejectedValue(new Error('quota exceeded'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      conversationsState.lastOnConversationDelete?.('conv-1');

      await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
      consoleErrorSpy.mockRestore();
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

    it('follows the grid rebind instead of minting when it already points at another OPEN conversation of THIS agent', async () => {
      // The grid closed conv-1's listing but it was grid-last with another
      // open conversation (conv-2) of the SAME agent still available — it
      // rebound the pane to that rather than ending the session. This tab
      // should follow the same rebind rather than minting a third,
      // redundant conversation and leaving conv-2 an orphaned empty thread.
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      agentPanesState.lastOnConversationClosed?.({
        conversationId: 'conv-1',
        next: 'conv-2',
        nextAgentPageId: 'agent-1',
      });

      expect(mockCreatePageConversation).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-2'));
    });

    it("still mints when the grid's rebind target belongs to a DIFFERENT agent", async () => {
      // `next` exists, but for another agent's conversation — not something
      // this page can show as its own `current`, so it must mint its own
      // replacement exactly as when there was no rebind at all.
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-3', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      agentPanesState.lastOnConversationClosed?.({
        conversationId: 'conv-1',
        next: 'conv-2',
        nextAgentPageId: 'other-agent',
      });

      await waitFor(() =>
        expect(mockCreatePageConversation).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: 'agent-1', sessionId: 'ses-1' }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-3'));
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

    it('a SECOND async gap — switching selection while the replacement mint itself is in flight — does not clobber the newer pick', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      conversationsState.current.conversations = [{ id: 'conv-2', sessionId: 'ses-1' }];
      let resolveCreate!: (value: { conversationId: string; sessionId: string | null }) => void;
      mockCreatePageConversation.mockReturnValue(
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
      );
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      // The grid closes conv-1's listing (still the CURRENT conversation) —
      // this starts the replacement mint, deliberately left pending.
      agentPanesState.lastOnConversationClosed?.({ conversationId: 'conv-1', next: null, nextAgentPageId: null });
      await waitFor(() => expect(mockCreatePageConversation).toHaveBeenCalledTimes(1));

      // WHILE that mint's own network call is still in flight, the user
      // selects a different history thread.
      await userEvent.click(screen.getByRole('tab', { name: /history/i }));
      fireEvent.click(await screen.findByTestId('history-select-conv-2'));
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2'));

      // The mint finally resolves.
      resolveCreate({ conversationId: 'conv-3', sessionId: 'ses-1' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The user's newer pick (conv-2) survives — not clobbered by conv-3,
      // the replacement for a conversation the user already moved on from.
      expect(screen.getByTestId('agent-panes')).toHaveTextContent('conv-2');
    });
  });

  describe('the past-conversations deep link (?conversationId=&sessionId=) is consumed exactly once', () => {
    // Left in the URL, a later refresh (after the user switches to a
    // different conversation via the History tab) would remount this
    // component, re-read the same stale params, and silently reopen the
    // original deep-linked thread instead of wherever the user actually
    // navigated to (review finding — a real bug on refresh, not cosmetic).
    it('strips conversationId/sessionId from the URL right after capturing them', () => {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('conversationId=conv-deep-link&sessionId=ses-deep-link') as ReturnType<typeof useSearchParams>,
      );
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?conversationId=conv-deep-link&sessionId=ses-deep-link');

      render(<AgentPageView page={pageFixture()} />);

      // Assert the user-visible CONTRACT (the final URL) rather than spying
      // on replaceState call details — a call-history assertion would pass
      // even if a LATER call re-added the params, and fail for an unrelated
      // history write elsewhere in the render path (review finding).
      const currentParams = new URL(window.location.href).searchParams;
      expect(currentParams.has('conversationId')).toBe(false);
      expect(currentParams.has('sessionId')).toBe(false);
    });

    it('does nothing when there was no deep-link conversationId to begin with', () => {
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1');

      render(<AgentPageView page={pageFixture()} />);

      expect(window.location.pathname).toBe('/dashboard/drive-1/page-1');
      expect(window.location.search).toBe('');
    });
  });

  describe('the console\'s Settings link (?tab=) — review finding: chatgpt-codex-connector on PR #2296', () => {
    it('lands on the requested tab on a fresh mount', () => {
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=settings') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=settings');

      render(<AgentPageView page={pageFixture()} />);

      expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('data-state', 'active');
    });

    it('strips ?tab= from the URL after consuming it', () => {
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=history') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=history');

      render(<AgentPageView page={pageFixture()} />);

      expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);
    });

    it('re-syncs the tab when the SAME mounted instance receives a new ?tab= — a query-only navigation Next does not remount for', () => {
      // The pane-bar link points at THIS agent's own page: when the user is
      // already on it (this page's own Chat tab can host a pane for its own
      // agent), clicking Settings is a query-only navigation to the exact
      // same route — Next keeps the component instance mounted, so a
      // mount-only read of `?tab=` would silently no-op.
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1');

      const { rerender } = render(<AgentPageView page={pageFixture()} />);
      expect(screen.getByRole('tab', { name: /^chat/i })).toHaveAttribute('data-state', 'active');

      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=settings') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=settings');
      rerender(<AgentPageView page={pageFixture()} />);

      expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('data-state', 'active');
      expect(new URL(window.location.href).searchParams.has('tab')).toBe(false);
    });

    it('re-applies a repeat ?tab=settings navigation even after the user has since clicked away — coderabbitai raised this as a distinct case from a differing tab value', async () => {
      // CodeRabbit's scenario: the URL goes from `tab=settings` to `tab=settings`
      // AGAIN while mounted (not `history` → `settings`, a genuinely repeated
      // value) — e.g. the user clicks the pane's Settings link, manually
      // switches to Chat, then clicks that SAME Settings link a second time.
      // The fix doesn't track "did the value change from its last observed
      // value" — it applies whatever valid `tab` is present on every
      // `searchParams` identity change (which Next produces on every real
      // navigation, including a repeat), so this needs no special-casing.
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=settings') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=settings');

      const { rerender } = render(<AgentPageView page={pageFixture()} />);
      expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('data-state', 'active');

      // The user navigates away locally (a plain tab click, not a URL change).
      await userEvent.click(screen.getByRole('tab', { name: /^chat/i }));
      expect(screen.getByRole('tab', { name: /^chat/i })).toHaveAttribute('data-state', 'active');

      // A second, independent navigation arrives carrying the SAME `tab=settings`
      // value (a fresh `URLSearchParams` instance, exactly as a real Next
      // navigation produces even for a repeated value).
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=settings') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=settings');
      rerender(<AgentPageView page={pageFixture()} />);

      expect(screen.getByRole('tab', { name: /settings/i })).toHaveAttribute('data-state', 'active');
    });

    it('ignores an unrecognized ?tab= value rather than crashing or clearing the current tab', () => {
      resolveTo({ conversationId: 'conv-1', sessionId: null });
      vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('tab=nonsense') as ReturnType<typeof useSearchParams>);
      window.history.replaceState({}, '', '/dashboard/drive-1/page-1?tab=nonsense');

      render(<AgentPageView page={pageFixture()} />);

      expect(screen.getByRole('tab', { name: /^chat/i })).toHaveAttribute('data-state', 'active');
    });
  });
});
