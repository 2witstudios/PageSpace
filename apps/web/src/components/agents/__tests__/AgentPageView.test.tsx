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
    hostConversationId,
    isReadOnly,
    onConversationClosed,
  }: {
    sessionId: string;
    driveId: string | null;
    initialConversation: { conversationId: string };
    chatContext?: string;
    hostConversationId?: string | null;
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
        data-host-conversation-id={hostConversationId ?? ''}
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

// Deliberately a PLAIN, non-admin user: sessions/chat/panes are open to
// every authenticated user now, so every test relying on this default
// doubles as proof a non-admin gets full access too. `user` is nullable —
// some tests exercise the genuinely-signed-out case. `isLoading` is modeled
// because `useAuthStore` persists `user`: a stale hydrated row plus a still-
// resolving auth check is a real state the component must treat as not yet
// authenticated (review #2326).
const authState = vi.hoisted(() => ({
  current: {
    user: { id: 'user-1', role: 'user' } as { id: string; role: string } | null,
    isLoading: false,
  },
}));
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

// The hook's OWN fetch/shared-cache behavior is covered by useAgentConfig.test.ts
// directly — this suite only needs to verify AgentPageView WIRES it correctly
// (calls it with page.id, passes the result through to the Settings tab).
const mockUseAgentConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/shared/hooks/useAgentConfig', () => ({
  useAgentConfig: (...args: unknown[]) => mockUseAgentConfig(...args),
}));

vi.mock('@/components/ai/page-agents', () => ({
  PageAgentSettingsTab: ({
    config,
    onDirtyChange,
    onSaved,
  }: {
    config: unknown;
    onDirtyChange?: (isDirty: boolean) => void;
    onSaved?: () => void;
  }) => (
    <div data-testid="page-agent-settings-tab" data-has-config={String(config !== null)}>
      <button onClick={() => onDirtyChange?.(true)}>mark-dirty</button>
      {/* Named to avoid the substring "save" — it would otherwise collide
          with `getByRole('button', { name: /save/i })` queries for the
          host's real Save button. Mirrors the real component: a successful
          save resets dirty around the same time onSaved fires. */}
      <button
        onClick={() => {
          onDirtyChange?.(false);
          onSaved?.();
        }}
      >
        finish-config-update
      </button>
    </div>
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

vi.mock('@/components/shared/PageWebhooksDialog', () => ({
  PageWebhooksDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="webhooks-dialog" /> : null),
}));

import AgentPageView from '../AgentPageView';
import {
  useAgentWorkspaceStore,
  __resetWorkspaceQueuesForTests,
} from '@/stores/agent-workspace/useAgentWorkspaceStore';

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
  mockUseAgentConfig.mockReturnValue({ config: null, setConfig: vi.fn() });
  resolvedConversation.current = { resolved: null, isLoading: true };
  authState.current = { user: { id: 'user-1', role: 'user' }, isLoading: false };
  conversationsState.current = {
    conversations: [],
    isLoading: false,
    deleteConversation: vi.fn(async () => {}),
    refreshConversations: vi.fn(),
  };
  conversationsState.lastOnConversationDelete = null;
  agentPanesState.lastOnConversationClosed = null;
  agentPanesState.firstOnConversationClosed = null;
  __resetWorkspaceQueuesForTests();
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
    // The page's own current conversation — lets the grid tell "the pane
    // showing exactly this conversation" (duplicate chrome, dropped) apart
    // from any other pane (a split on a different conversation — even of the
    // SAME agent — which keeps its own selector/tabs).
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-host-conversation-id', 'conv-1');
    // Defaults to the agent page's own drive while the session record is
    // unresolved — correct for the overwhelming common case.
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', 'drive-1');
    expect(screen.queryByTestId('plain-chat')).not.toBeInTheDocument();
  });

  it('a session-less conversation wears the SAME pane bar, carrying the new-conversation control', async () => {
    // The whole point: which branch the user lands on is a property of the
    // conversation they cannot see (binding is congenital and permanent), so
    // the chrome must not differ. Before this, the plain branch rendered no
    // header at all and the only way to start a conversation was the History
    // tab.
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));
    expect(screen.getByTestId('pane-bar')).toBeInTheDocument();
    // The agent names the bar, exactly as a bound pane's identity does.
    expect(screen.getByTestId('pane-bar')).toHaveTextContent('My Agent');

    await userEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));

    await waitFor(() =>
      expect(mockCreatePageConversation).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1' }),
      ),
    );
    // The same act the History tab's "New Conversation" performs — it lands on
    // the Chat tab showing the mint, without the user ever visiting History.
    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-2'));
  });

  it('the bar\'s "+" cannot double-mint — the second click of a pair is swallowed', async () => {
    // The mint has no idempotency key server-side, so two clicks would be two
    // conversations. That was survivable while this action lived only behind
    // the History tab; it now sits permanently beside the chat.
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    let release: (value: { conversationId: string; sessionId: string | null }) => void = () => {};
    mockCreatePageConversation.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));

    const plus = screen.getByRole('button', { name: 'Start a new conversation' });
    fireEvent.click(plus);
    fireEvent.click(plus);

    expect(mockCreatePageConversation).toHaveBeenCalledTimes(1);

    release({ conversationId: 'conv-2', sessionId: null });
    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-2'));

    // And the guard RELEASES: a mint that finished must not leave the control
    // dead for the rest of the session.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start a new conversation' })).not.toBeDisabled(),
    );
  });

  it('a mint that FAILS releases the control and says so, rather than rejecting into nothing', async () => {
    // Every caller fires this as `void handleCreateNew()`. Without the catch,
    // the rejection is unhandled — which in this repo fails the CI job while
    // every test still reports passing — and the user sees a button that simply
    // does nothing.
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    mockCreatePageConversation.mockRejectedValue(new Error('spawn refused'));
    render(<AgentPageView page={pageFixture()} />);
    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));

    await userEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));

    await waitFor(() => expect(mockCreatePageConversation).toHaveBeenCalled());
    // Still on the conversation it had, and the control is usable again.
    expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start a new conversation' })).not.toBeDisabled(),
    );
  });

  it('a conversation whose SESSION is a global-assistant session passes the SESSION drive (null), not the agent page drive', async () => {
    // Reachable now that a global session can host any accessible agent's
    // conversation (create-conversation-in-workspace.ts): this agent page's
    // most-recent conversation can be bound to a global session. AgentPanes
    // must scope to the session's OWN drive (null), never `page.driveId` —
    // otherwise `agentWorkspacesKey`/the picker look in the wrong workspace.
    // The raw session-record shape `useSessionRecord` resolves to (not a
    // pre-coalesced driveId) — a RESOLVED global session, session.driveId null.
    mockUseSWR.mockReturnValue({ data: { session: { driveId: null } } });
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-global' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-global/conv-1'));
    expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', '');
  });

  it('a signed-out visitor gets the plain chat even for a session-bound conversation (review M2)', async () => {
    // A shared session-bound thread can be reached by a visitor whose auth
    // hasn't resolved yet (or has none); a grid whose every affordance 403s
    // — except the destructive last-pane-close — is worse than the chat
    // they can actually use. Sessions/chat/panes are open to every
    // AUTHENTICATED user now (not just admins), so this only still applies
    // when there's no user at all.
    authState.current = { user: null, isLoading: false };
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));
    expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument();
  });

  it('a STALE persisted user with auth still resolving gets the plain chat, not the pane grid (review #2326)', async () => {
    // `useAuthStore` persists `user`, so after an expired session a hydrated
    // stale row coexists with a still-in-flight /api/auth/me. The grid (and
    // its session actions) must wait for resolution, not trust the stale row.
    authState.current = { user: { id: 'user-1', role: 'user' }, isLoading: true };
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('plain-chat')).toHaveTextContent('conv-1'));
    expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument();
  });

  it('a non-admin authenticated user gets the real pane grid for a session-bound conversation', async () => {
    authState.current = { user: { id: 'user-2', role: 'user' }, isLoading: false };
    resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
    render(<AgentPageView page={pageFixture()} />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(screen.queryByTestId('plain-chat')).not.toBeInTheDocument();
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
  });

  it('disables Save Settings until PageAgentSettingsTab reports a dirty change', async () => {
    mockUseAgentConfig.mockReturnValue({
      config: { systemPrompt: '', enabledTools: [], availableTools: [] },
      setConfig: vi.fn(),
    });
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await userEvent.click(screen.getByRole('tab', { name: /settings/i }));
    const saveButton = await screen.findByRole('button', { name: /save settings/i });
    expect(saveButton).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'mark-dirty' }));

    expect(saveButton).not.toBeDisabled();
  });

  it('shows an inline "Saved" confirmation after a save, then reverts to disabled', async () => {
    mockUseAgentConfig.mockReturnValue({
      config: { systemPrompt: '', enabledTools: [], availableTools: [] },
      setConfig: vi.fn(),
    });
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    await userEvent.click(screen.getByRole('tab', { name: /settings/i }));
    await userEvent.click(screen.getByRole('button', { name: 'mark-dirty' }));
    const saveButton = screen.getByRole('button', { name: /save settings/i });
    expect(saveButton).not.toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'finish-config-update' }));

    expect(await screen.findByRole('button', { name: /saved/i })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: /^save settings$/i })).toBeDisabled(), {
      timeout: 3000,
    });
  });

  it('loads the agent config so the Settings tab has data, not an eternal spinner', async () => {
    // The rewrite once dropped this fetch entirely — PageAgentSettingsTab
    // shows its loading state until config arrives, so a page that never
    // fetches it has a Settings tab that never works (codex review, P1).
    // Now sourced from the SWR-backed useAgentConfig hook (shared with every
    // pane showing this agent's Settings tab, see useAgentConfig.test.ts for
    // its own fetch/cache-sharing behavior) — this suite only verifies
    // AgentPageView wires it with the right pageId and threads the result
    // through to the Settings tab.
    mockUseAgentConfig.mockReturnValue({
      config: { systemPrompt: '', enabledTools: [], availableTools: [] },
      setConfig: vi.fn(),
    });
    resolveTo({ conversationId: 'conv-1', sessionId: null });
    render(<AgentPageView page={pageFixture()} />);

    expect(mockUseAgentConfig).toHaveBeenCalledWith('agent-1');
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
      '/dashboard/drive-1/agents?workspace=ses-1&c=conv-1&agent=agent-1',
    );
  });

  it('hides the console cross-link from a signed-out visitor — the console would refuse them', async () => {
    authState.current = { user: null, isLoading: false };
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

      await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('/api/agent-workspaces?driveId=drive-1', expect.any(Function), { revalidate: false }));
      const [, updater] = mockMutate.mock.calls.find(([key]) => key === '/api/agent-workspaces?driveId=drive-1')!;
      const updated = (updater as (current: unknown) => unknown)({
        sessions: [{ workspaceId: 'ses-1', sessionId: 'ses-1', conversations: [] }],
      });
      expect(updated).toEqual({
        sessions: [{ workspaceId: 'ses-1', sessionId: 'ses-1', conversations: [{ conversationId: 'conv-2', agentPageId: 'agent-1', lastMessageAt: null }] }],
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
      expect(predicate('/api/agent-workspaces?driveId=drive-1')).toBe(true);
      expect(predicate('/api/pages/agent-1')).toBe(false);
    });

    it('prunes the pane that was showing the deleted conversation, wherever it lived in the grid', async () => {
      resolveTo({ conversationId: 'conv-1', sessionId: 'ses-1' });
      mockCreatePageConversation.mockResolvedValue({ conversationId: 'conv-2', sessionId: 'ses-1' });
      render(<AgentPageView page={pageFixture()} />);
      await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());

      // A grid where the deleted conversation is NOT the focused pane — the
      // replacement must land where the thread actually WAS, not "wherever the
      // user happens to be looking".
      useAgentWorkspaceStore.getState().hydrateFromServer('ses-1', {
        rev: 1,
        nodes: [
          { nodeType: 'root', id: 'ses-1', parentId: null, position: 0, axis: 'row' },
          { nodeType: 'pane', id: 'n-stale', parentId: 'ses-1', position: 0, target: { kind: 'chat', id: 'conv-1' } },
          { nodeType: 'pane', id: 'n-other', parentId: 'ses-1', position: 1, target: { kind: 'chat', id: 'conv-9' } },
        ],
        targets: [],
      });
      useAgentWorkspaceStore.getState().selectNode('ses-1', 'n-other');

      conversationsState.lastOnConversationDelete?.('conv-1');

      // A binding is for life, so this is a PLACEMENT, not a rebind: the
      // replacement takes a node of its own where the stale one was, and the
      // stale node is DESTROYED. It used to park — a member off the screen —
      // which is the state this correction removes; a node showing a thread
      // whose history is gone has nothing left to be a member for.
      await waitFor(() => {
        const nodes = useAgentWorkspaceStore.getState().workspaces['ses-1'].nodes;
        const replacement = nodes.find(
          (node) => node.nodeType === 'pane' && node.target?.kind === 'chat' && node.target.id === 'conv-2',
        );
        expect(replacement?.parentId).toBe('ses-1');
        expect(nodes.find((node) => node.id === 'n-stale')).toBeUndefined();
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
