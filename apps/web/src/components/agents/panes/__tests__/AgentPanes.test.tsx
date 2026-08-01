/**
 * AgentPanes — the container's own IO: minting conversations/shells into a
 * session, and the pane-close lifecycle (issue #2263, and the session →
 * conversation → panes level restored by a later audit follow-up).
 *
 * The properties worth pinning hardest: **closing the last pane is
 * confirmed and server-first** — no grid mutation happens until the DELETE
 * succeeds, so a failed teardown leaves the user exactly where they were
 * rather than spawning a second session behind their back; **a terminal pane
 * close kills its shell**; **a pane closed mid-mint doesn't resurrect** once
 * its POST resolves; and **closing a conversation's last pane closes THAT
 * listing** — only the session's own last open listing closing ends the
 * session. Leaf renderers (`PaneChat`, `Shell`) are mocked — this suite is
 * the container's wiring, not their internals. The real store and the real
 * pane-reducer run underneath, same as `AgentsSidebar.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { toast } from 'sonner';

const mockPost = vi.fn();
const mockDel = vi.fn();
const mockFetchWithAuth = vi.fn();
const { ApiRequestError } = vi.hoisted(() => ({
  ApiRequestError: class ApiRequestError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
    }
  },
}));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  post: (...args: unknown[]) => mockPost(...args),
  del: (...args: unknown[]) => mockDel(...args),
  ApiRequestError,
}));

let cuidCounter = 0;
vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => `new-id-${++cuidCounter}`,
}));

interface MockPageAgent {
  id: string;
  title: string;
  driveId: string;
  /** Only set in the cross-drive (global-assistant) fixtures below. */
  driveName?: string;
}
const mockUsePageAgents = vi.fn<() => { allAgents: MockPageAgent[]; isLoading: boolean }>(() => ({
  allAgents: [
    { id: 'agent-1', title: 'Researcher', driveId: 'drive-1' },
    { id: 'agent-2', title: 'Writer', driveId: 'drive-1' },
  ],
  isLoading: false,
}));
vi.mock('@/hooks/page-agents/usePageAgents', () => ({
  usePageAgents: () => mockUsePageAgents(),
}));

vi.mock('../PaneChat', () => ({
  default: ({ conversationId }: { conversationId: string }) => <div data-testid="pane-chat">{conversationId}</div>,
}));
vi.mock('../../shell/Shell', () => ({
  default: ({ shellId }: { shellId: string }) => <div data-testid="pane-shell">{shellId}</div>,
}));
// Leaf renderers for the pane's History/Settings tabs — same philosophy as
// PaneChat/Shell above: this suite is the pane's own tab-switching wiring,
// not PageAgentHistoryTab/PageAgentSettingsTab's internals (867 lines of
// react-hook-form for the latter — exercising it for real here would test
// a different component's own test file's job).
vi.mock('@/components/ai/page-agents', () => ({
  PageAgentHistoryTab: ({
    conversations,
    onSelectConversation,
    onDeleteConversation,
  }: {
    conversations: Array<{ id: string; title: string | null; sessionId: string | null }>;
    onSelectConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
  }) => (
    <div data-testid="pane-history-tab">
      {conversations.length} conversations
      {conversations.map((c) => (
        <div key={c.id}>
          <button onClick={() => onSelectConversation(c.id)}>select-{c.id}</button>
          <button onClick={() => onDeleteConversation(c.id)}>delete-{c.id}</button>
        </div>
      ))}
    </div>
  ),
  PageAgentSettingsTab: ({ pageId, config }: { pageId: string; config: unknown }) => (
    <div data-testid="pane-settings-tab" data-page-id={pageId} data-has-config={String(config !== null)} />
  ),
}));

import AgentPanes from '../AgentPanes';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });

/**
 * The default routing every test starts from: empty shells, an empty
 * session-conversations list (both `ChatPaneIdentity`'s switch-decision data
 * AND `decideClosePane`'s close-decision data), and `useResolvedAgent`'s two
 * lookups per fixture agent (id/title come from `mockUsePageAgents` above). A
 * test that cares about a specific route layers its own `mockImplementation`
 * on top, falling back to this for every other URL.
 */
function defaultFetchRoute(url: string): unknown {
  if (url.includes('/shells')) return { shells: [] };
  if (url.includes('/api/agent-sessions')) return { sessions: [] };
  if (url === '/api/pages/agent-1') return { id: 'agent-1', title: 'Researcher', driveId: 'drive-1' };
  if (url === '/api/pages/agent-1/agent-config') return {};
  if (url === '/api/pages/agent-2') return { id: 'agent-2', title: 'Writer', driveId: 'drive-1' };
  if (url === '/api/pages/agent-2/agent-config') return {};
  return {};
}

/**
 * Mock the shared session-conversations listing SWR read — the input both
 * the pane bar selector's switch decision and the pane grid's close decision
 * read from. Shared across describe blocks below rather than duplicated.
 */
function mockSessionConversations(
  conversations: Array<{ conversationId: string; agentPageId: string | null; lastMessageAt?: string | null }>,
) {
  mockFetchWithAuth.mockImplementation(async (url: string) => {
    if (url.includes('/api/agent-sessions')) {
      return jsonOk({
        sessions: [{ sessionId: 'ses-1', conversations: conversations.map((c) => ({ lastMessageAt: null, ...c })) }],
      });
    }
    return jsonOk(defaultFetchRoute(url));
  });
}

function renderPanes(props: Partial<React.ComponentProps<typeof AgentPanes>> = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentPanes
        sessionId="ses-1"
        driveId="drive-1"
        initialConversation={{ conversationId: 'conv-1', agentPageId: 'agent-1', name: 'Conversation' }}
        {...props}
      />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cuidCounter = 0;
  useAgentWorkspaceStore.setState({ workspaces: {} });
  usePendingStreamsStore.setState({ streams: new Map() });
  mockUsePageAgents.mockReturnValue({
    allAgents: [
      { id: 'agent-1', title: 'Researcher', driveId: 'drive-1' },
      { id: 'agent-2', title: 'Writer', driveId: 'drive-1' },
    ],
    isLoading: false,
  });
  mockFetchWithAuth.mockImplementation(async (url: string) => jsonOk(defaultFetchRoute(url)));
});

describe('AgentPanes', () => {
  it('seeds the grid on its first conversation and renders the chat pane', async () => {
    renderPanes();
    await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
  });

  describe('closing a NON-last pane', () => {
    it('closes locally with no confirm dialog and no session DELETE', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = Object.values(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes)[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      await user.click(closeButtons[0]);

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mockDel).not.toHaveBeenCalled();
    });

    it('closing a terminal pane kills its shell', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const workspace = useAgentWorkspaceStore.getState().workspaces['ses-1'];
      const chatPaneId = workspace.columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', chatPaneId));
      const termPaneId = Object.values(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns)
        .flatMap((c) => c.panes)
        .find((p) => p.id !== chatPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', termPaneId, { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null }),
      );

      mockDel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toBeInTheDocument());
      const closeButtons = screen.getAllByLabelText('Close pane');
      // The terminal pane's own close button — bar order follows column order.
      await user.click(closeButtons[closeButtons.length - 1]);

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9'),
      );
    });
  });

  describe('closing the LAST pane (findings 1 + 2)', () => {
    // Since round 10 (caught in review): the decision layer never
    // short-circuits straight to `end-session` from the client's own
    // snapshot — it always attempts the scoped conversation DELETE first,
    // and only the SERVER's authoritative 409 `last_conversation` response
    // triggers the confirm dialog (via the exact same `beginEndSessionConfirm`
    // the non-chat-pane path already used). Every test here mocks that 409
    // to reach the dialog, exactly mirroring the real server contract.
    it('asks for confirmation rather than closing immediately (after the server confirms this is the last listing)', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockRejectedValue(new ApiRequestError('conflict', 409));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      // Nothing was mutated — the grid is still exactly what it was.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
    });

    it('cancelling leaves the session and the grid untouched', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockRejectedValue(new ApiRequestError('conflict', 409));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1');
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('confirming DELETEs the session, THEN drops the grid and reports it ended', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockImplementation(async (url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-1') throw new ApiRequestError('conflict', 409);
        return undefined;
      });
      const onSessionEnded = vi.fn();
      renderPanes({ onSessionEnded });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
      await waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
    });

    it('warns (but still ends the session) when the server reports other open conversations existed', async () => {
      // Ending is unconditional by design and can't be prevented client
      // side — but THIS dialog's confirm was shown because the pane's own
      // close 409'd on a "this looks like the last listing" belief that can
      // go stale (a conversation minted elsewhere committed in the window
      // between that 409 and this confirm). Silently destroying more than
      // expected deserves a signal, even though nothing here can undo it
      // (caught in review).
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockImplementation(async (url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-1') throw new ApiRequestError('conflict', 409);
        return { ok: true, spriteTornDown: true, hadOtherOpenConversations: true };
      });
      const warnSpy = vi.spyOn(toast, 'warning').mockImplementation(() => '');
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(warnSpy).toHaveBeenCalled());
      warnSpy.mockRestore();
    });

    it('a failed DELETE leaves the grid exactly as it was — no rollback needed because nothing moved', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockImplementation(async (url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-1') throw new ApiRequestError('conflict', 409);
        throw new Error('sandbox teardown failed');
      });
      const onSessionEnded = vi.fn();
      renderPanes({ onSessionEnded });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
      expect(onSessionEnded).not.toHaveBeenCalled();
      // The session is still live locally — no second session gets minted
      // because nothing here ever creates one.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      expect(screen.getByTestId('pane-chat')).toBeInTheDocument();
    });

    it("is a no-op on a brand-new session whose OWN entry hasn't appeared in an already-warm cache — never guesses confirmed-empty", async () => {
      // The `/api/agent-sessions` cache can be warm from ANOTHER session in
      // the same drive (so `sessionsData` is truthy) while THIS brand-new
      // session's own row hasn't appeared in it yet — a real fact distinct
      // from "loaded and confirmed to have no other conversations." Treating
      // the former as the latter would offer to end a session whose actual
      // membership is still unknown (caught in review).
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) {
          return jsonOk({ sessions: [{ sessionId: 'ses-other', conversations: [] }] });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      // No dialog, no DELETE, no local mutation — the fact is unverified so
      // the close is a pure no-op rather than a guess in either direction.
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mockDel).not.toHaveBeenCalled();
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      expect(screen.getByTestId('pane-chat')).toBeInTheDocument();
    });
  });

  describe("closing a conversation's listing (session → conversation → panes)", () => {
    it("closes the last pane bound to an agent's conversation via the session-scoped DELETE, silently — no dialog", async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }, { conversationId: 'conv-2', agentPageId: 'agent-2' }]);
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', secondPaneId, { kind: 'chat', name: 'Conversation', targetId: 'conv-2', agentPageId: 'agent-2' }),
      );
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      await user.click(closeButtons[0]);

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
        ).toHaveLength(1),
      );
    });

    it('rebinds the grid-last pane to the most recently active OTHER open listing rather than ending the session', async () => {
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2', lastMessageAt: '2026-01-15T00:00:00.000Z' },
      ]);
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-2'));
      // The grid never emptied — still exactly one pane, now pointed elsewhere.
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
    });

    it("falls back to the EndSessionDialog when the server says this was the session's last open listing (409)", async () => {
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2' },
      ]);
      mockDel.mockRejectedValue(new ApiRequestError('conflict', 409));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      // The grid is untouched — this is the SAME peek-then-confirm flow as
      // any other end-session, nothing was mutated by the failed close.
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
    });

    it('closing one of TWO panes showing the SAME conversation is a pure layout close, not a listing close', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', secondPaneId, { kind: 'chat', name: 'Conversation', targetId: 'conv-1', agentPageId: 'agent-1' }),
      );
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      await user.click(closeButtons[0]);

      expect(mockDel).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
        ).toHaveLength(1),
      );
    });

    it('does not destroy a pane reassigned to a NEW conversation while its close DELETE was still in flight', async () => {
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2' },
      ]);
      let resolveDel!: () => void;
      mockDel.mockReturnValue(new Promise<void>((resolve) => (resolveDel = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      // A second pane so closing the first is NOT grid-last (close-conversation, no rebind).
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      await user.click(closeButtons[0]);
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));

      // WHILE that DELETE is still pending, this exact pane gets reassigned —
      // e.g. the pane bar's agent selector switched it, or a fresh mint
      // landed here. The stale close must not clobber it once it resolves.
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', paneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'conv-reassigned',
          agentPageId: 'agent-3',
        }),
      );

      resolveDel();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const paneAfter = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === paneId);
      expect(paneAfter?.scope).toMatchObject({ targetId: 'conv-reassigned', agentPageId: 'agent-3' });
    });

    it('does not tell the host to recover a pane that was reassigned while its close DELETE was still in flight', async () => {
      // Same race as above, but checking the HOST callback rather than the
      // local pane mutation: even though `paneStillShows` already protects
      // the pane's own scope, an unconditional `onConversationClosed` would
      // still tell a host (AgentPageView/AgentsSurface) to recover from the
      // now-irrelevant closed conversation — which tracks its own "current"
      // independently of any specific pane — potentially overwriting
      // whatever the user just picked for this exact pane (caught in review).
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2' },
      ]);
      let resolveDel!: () => void;
      mockDel.mockReturnValue(new Promise<void>((resolve) => (resolveDel = resolve)));
      const onConversationClosed = vi.fn();
      renderPanes({ onConversationClosed });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      await user.click(closeButtons[0]);
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));

      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', paneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'conv-reassigned',
          agentPageId: 'agent-3',
        }),
      );

      resolveDel();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onConversationClosed).not.toHaveBeenCalled();
    });

    it("ends the session (via forgetWorkspace) when closing the session's LAST open listing, even with a terminal pane remaining", async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockImplementation(async (url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-1') throw new ApiRequestError('conflict', 409);
        return undefined;
      });
      const onSessionEnded = vi.fn();
      renderPanes({ onSessionEnded });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const chatPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', chatPaneId));
      const termPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== chatPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', termPaneId, { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toBeInTheDocument());

      const user = userEvent.setup();
      const closeButtons = screen.getAllByLabelText('Close pane');
      // The chat pane's own close button (bar order follows column order).
      await user.click(closeButtons[0]);
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
      await waitFor(() => expect(onSessionEnded).toHaveBeenCalledTimes(1));
      // The WHOLE workspace is gone, including the terminal pane that was
      // never itself targeted by the close.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
    });

    it('rebinds a lone TERMINAL pane to an open listing that has no pane here, instead of ending the session', async () => {
      // conv-1 is the grid's actual pane; conv-2 is a real open listing with
      // NO pane anywhere in this grid (e.g. a background worker minted it) —
      // exactly the gap an adversarial review caught in `decideClosePane`'s
      // non-chat-pane branch.
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2', lastMessageAt: '2026-01-15T00:00:00.000Z' },
      ]);
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const chatPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', chatPaneId, { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      // The terminal's own shell is still killed, same as any terminal close.
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9'));
      // No session DELETE, no dialog — the pane rebound instead of ending anything.
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-2'));
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
    });
  });

  describe('picking an agent (mint lifecycle)', () => {
    it('mints a conversation into the session and binds the pane', async () => {
      mockPost.mockResolvedValue({});
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-2/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));
    });

    it('a failed mint resets the pane back to the picker, not a dead sentinel scope', async () => {
      mockPost.mockRejectedValue(new Error('quota exceeded'));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));

      await waitFor(() => {
        const newPane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id !== paneId)!;
        expect(newPane.scope).toBeNull();
      });
      expect(await screen.findAllByTestId('pane-picker')).toHaveLength(1);
    });

    it('a pane closed mid-mint does not resurrect once the POST resolves, and the orphaned row is cleaned up', async () => {
      let resolvePost!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));
      const mintingPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;

      // The user closes the still-minting pane before the network resolves.
      act(() => {
        useAgentWorkspaceStore.getState().closePane('ses-1', mintingPaneId);
      });
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);

      resolvePost({});

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/new-id-1'),
      );
      // Still just the one pane — the resolved mint did not resurrect it.
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
    });

    it('a pane REBOUND to another listing mid-mint does not get clobbered once the abandoned mint resolves', async () => {
      // A grid-last close can rebind this exact pane to a different open
      // conversation while a mint it started is still in flight — the
      // mint's own completion must see that and clean up rather than
      // overwrite the rebind with its own now-abandoned result.
      let resolvePost!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));
      const mintingPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;

      // Simulate a grid-last close rebinding THIS pane to another already-open
      // conversation, exactly as `handleClosePane`'s `rebind-pane` branch does
      // — while the mint above is still awaiting its POST.
      act(() => {
        useAgentWorkspaceStore.getState().assignPane('ses-1', mintingPaneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'rebound-conv',
          agentPageId: 'agent-3',
        });
      });

      resolvePost({});

      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/new-id-1'),
      );
      // The rebind survives — still pointed at the OTHER conversation, not
      // silently overwritten by the abandoned mint's own conversationId.
      const pane = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === mintingPaneId)!;
      expect(pane.scope).toMatchObject({ targetId: 'rebound-conv', agentPageId: 'agent-3' });
    });

    it('a pane REBOUND to another listing mid-mint survives a REJECTED mint too, not just a resolved one', async () => {
      // Same rebind-survives rule as the success-path test above, but for the
      // catch branch: a mint that fails outright must not reset a pane a
      // grid-last close already rebound to something else while the request
      // was in flight (round-4b review — the earlier fix only guarded the
      // success path's assignPane call, not the catch block's resetPane).
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let rejectPost!: (error: unknown) => void;
      mockPost.mockReturnValue(new Promise((_resolve, reject) => (rejectPost = reject)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));
      const mintingPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;

      act(() => {
        useAgentWorkspaceStore.getState().assignPane('ses-1', mintingPaneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'rebound-conv',
          agentPageId: 'agent-3',
        });
      });

      act(() => {
        rejectPost(new Error('quota exceeded'));
      });

      await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
      // The rebind survives the rejection too — not reset to a dead sentinel.
      const pane = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === mintingPaneId)!;
      expect(pane.scope).toMatchObject({ targetId: 'rebound-conv', agentPageId: 'agent-3' });
      consoleErrorSpy.mockRestore();
    });
  });

  describe('a global-assistant session (driveId null)', () => {
    beforeEach(() => {
      // Genuinely cross-drive (unlike the shared drive-1-only default
      // fixture): proves the picker aggregates across every accessible
      // drive, not just whichever single drive the fixture happens to use
      // (a narrower, buggy filter could pass against a single-drive fixture
      // by coincidence).
      mockUsePageAgents.mockReturnValue({
        allAgents: [
          { id: 'agent-1', title: 'Researcher', driveId: 'drive-1', driveName: 'Alpha' },
          { id: 'agent-2', title: 'Writer', driveId: 'drive-2', driveName: 'Beta' },
        ],
        isLoading: false,
      });
    });

    it('offers every accessible agent across drives, not an empty list', async () => {
      renderPanes({
        driveId: null,
        initialConversation: { conversationId: 'conv-1', agentPageId: null, name: 'Conversation' },
      });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      // Both cross-drive fixture agents show up — the picker used to be
      // unconditionally empty for a null driveId (`enabled: driveId !== null`
      // plus a `agent.driveId === driveId` filter that could never match).
      expect(await screen.findByTestId('pick-agent-agent-1')).toBeInTheDocument();
      expect(screen.getByTestId('pick-agent-agent-2')).toBeInTheDocument();
      expect(screen.getByTestId('pick-global-assistant')).toBeInTheDocument();
      // Cross-drive entries are labeled with their own drive — page titles
      // aren't unique, so two drives can hold identically-titled agents that
      // would otherwise be indistinguishable in the list.
      expect(within(screen.getByTestId('pick-agent-agent-1')).getByText('Alpha')).toBeInTheDocument();
      expect(within(screen.getByTestId('pick-agent-agent-2')).getByText('Beta')).toBeInTheDocument();
    });

    it('mints a picked cross-drive agent into the session, same as a drive session would', async () => {
      mockPost.mockResolvedValue({});
      renderPanes({
        driveId: null,
        initialConversation: { conversationId: 'conv-1', agentPageId: null, name: 'Conversation' },
      });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-agent-agent-2'));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-2/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));
    });
  });

  describe('picking a shell', () => {
    it('opens a shell in the session and binds the pane to it', async () => {
      mockPost.mockResolvedValue({ shell: { shellId: 'shell-9', name: 'shell-1' } });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('pick-shell'));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells', {}),
      );
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toHaveTextContent('shell-9'));
    });
  });

  describe('reattaching an existing shell (finding 3)', () => {
    it('offers a shell not currently shown in any pane, and binds it with no POST', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) =>
        url.includes('/shells')
          ? jsonOk({ shells: [{ shellId: 'shell-old', name: 'build' }] })
          : jsonOk(defaultFetchRoute(url)),
      );
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', paneId));

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('reattach-shell-shell-old'));

      expect(mockPost).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toHaveTextContent('shell-old'));
    });

    it('does not offer a shell already bound to a pane in this grid', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) =>
        url.includes('/shells')
          ? jsonOk({ shells: [{ shellId: 'shell-bound', name: 'build' }] })
          : jsonOk(defaultFetchRoute(url)),
      );
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const chatPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', chatPaneId));
      const termPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== chatPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', termPaneId, { kind: 'terminal', name: 'build', targetId: 'shell-bound', agentPageId: null }),
      );

      act(() => useAgentWorkspaceStore.getState().splitDown('ses-1', termPaneId));

      await waitFor(() =>
        expect(screen.queryByTestId('reattach-shell-shell-bound')).not.toBeInTheDocument(),
      );
    });
  });

  describe('keyboard activation (finding 7)', () => {
    it('focusing a control inside a pane activates it, not only a click', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      // The split focused the new pane; move active back to the first so the
      // test can prove a FOCUS (not a click) moves it again.
      act(() => useAgentWorkspaceStore.getState().selectPane('ses-1', firstPaneId));

      const closeButtons = screen.getAllByLabelText('Close pane');
      act(() => closeButtons[closeButtons.length - 1].focus());

      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].activePaneId).not.toBe(firstPaneId),
      );
    });
  });

  describe('the pane bar agent selector (restored /development AISelector)', () => {
    /** Every interactive test needs THIS session's entry present in the switch-decision data first — see the readiness tests below for why. */
    async function findEnabledSelector(name: RegExp) {
      const button = await screen.findByRole('button', { name });
      await waitFor(() => expect(button).not.toBeDisabled());
      return button;
    }

    it("shows the pane's current agent as the bar identity", async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      expect(await screen.findByRole('button', { name: /Researcher/ })).toBeInTheDocument();
    });

    it("has a Settings tab for the pane's agent, which switches the pane body to the settings form", async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const settingsTab = await screen.findByRole('tab', { name: /researcher settings/i });
      await userEvent.click(settingsTab);

      expect(await screen.findByTestId('pane-settings-tab')).toHaveAttribute('data-page-id', 'agent-1');
      expect(screen.queryByTestId('pane-chat')).not.toBeInTheDocument();
    });

    it('hides the Settings tab for the Assistant (no agent page, so no settings)', async () => {
      renderPanes({
        initialConversation: { conversationId: 'conv-1', agentPageId: null, name: 'Assistant' },
      });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      expect(screen.queryByRole('tab', { name: /settings/i })).not.toBeInTheDocument();
    });

    it('has a History tab that switches the pane body to the conversation list, and back to Chat on selection', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const historyTab = await screen.findByRole('tab', { name: /history/i });
      await userEvent.click(historyTab);

      expect(await screen.findByTestId('pane-history-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('pane-chat')).not.toBeInTheDocument();

      const chatTab = screen.getByRole('tab', { name: /^chat$/i });
      await userEvent.click(chatTab);

      expect(await screen.findByTestId('pane-chat')).toBeInTheDocument();
      expect(screen.queryByTestId('pane-history-tab')).not.toBeInTheDocument();
    });

    const conversationsFixture = (entries: Array<{ id: string; title: string; sessionId: string | null }>) =>
      jsonOk({
        conversations: entries.map((e) => ({
          id: e.id,
          title: e.title,
          preview: '',
          createdAt: new Date('2026-01-01').toISOString(),
          updatedAt: new Date('2026-01-01').toISOString(),
          messageCount: 1,
          sessionId: e.sessionId,
          lastMessage: { role: 'user', timestamp: new Date('2026-01-01').toISOString() },
        })),
      });

    // review finding — chatgpt-codex-connector on PR #2299: picking a History
    // entry already open in another pane bypassed the store's deduplicating
    // openConversation path, mounting a second independently interactive
    // surface for the same transcript.
    it('focuses an existing pane instead of duplicating it when the picked History conversation is already open elsewhere', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-other', title: 'Other chat', sessionId: null }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Other chat',
          targetId: 'conv-other',
          agentPageId: 'agent-1',
        }),
      );

      const user = userEvent.setup();
      // Pane bar and its pane's body are siblings under the same `group/pane`
      // container — locate the pane bar whose OWN pane currently renders
      // conv-1 (the first pane), rather than assuming DOM/array order lines
      // up with pane creation order.
      const bars = screen.getAllByTestId('pane-bar');
      const firstPaneBar = bars.find((bar) =>
        within(bar.parentElement as HTMLElement).queryByTestId('pane-chat')?.textContent === 'conv-1',
      )!;
      await user.click(within(firstPaneBar).getByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-other' }));

      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].activePaneId).toBe(secondPaneId),
      );
      // The first pane's own binding is untouched — no duplicate was created there.
      const firstPaneAfter = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === firstPaneId);
      expect(firstPaneAfter?.scope?.targetId).toBe('conv-1');
    });

    // review finding — chatgpt-codex-connector on PR #2299: switching to Chat
    // immediately (fire-and-forget) after starting an async reopen showed the
    // OLD pane content as if a failed pick had succeeded.
    it('stays on the History tab when reopening a same-session conversation fails, rather than following the failed pick to Chat', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-closed', title: 'Closed chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      mockPost.mockRejectedValue(new Error('session full'));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-closed' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-closed/reopen', {}),
      );
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();
      expect(screen.queryByTestId('pane-chat')).not.toBeInTheDocument();
    });

    // review finding — chatgpt-codex-connector on PR #2299: a slow reopen's
    // completion, arriving after the user has already picked something else
    // on the SAME pane, must not overwrite that newer choice.
    it('ignores a stale reopen completion superseded by a second pick on the same pane', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-slow', title: 'Slow chat', sessionId: 'ses-1' },
            { id: 'conv-fast', title: 'Fast chat', sessionId: null },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveSlowReopen!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolveSlowReopen = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Starts the slow reopen — still pending, so the pane stays on History
      // (per the previous fix) rather than following it to Chat.
      await user.click(await screen.findByRole('button', { name: 'select-conv-slow' }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();

      // A second pick on the SAME pane, before the first resolves — no
      // reopen needed (unbound), so it lands immediately.
      await user.click(await screen.findByRole('button', { name: 'select-conv-fast' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-fast'));

      // NOW the stale reopen resolves — must be ignored, AND rolled back:
      // it succeeded server-side (closedInSessionAt cleared, a cap slot
      // consumed) for a pick nothing shows anymore, which could otherwise
      // make a later reopen fail as "session full" for no visible reason.
      resolveSlowReopen({});
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('conv-fast');
      });
      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-slow'),
      );
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 7): the
    // rollback above must not fire when the SAME conversation was picked
    // twice and the NEWER pick's reopen wins the race, legitimately landing
    // in a pane before the older (now-stale) reopen resolves — closing it
    // back out would rip a currently-visible conversation out of its pane.
    it('does not roll back a stale reopen when a newer pick already landed the same conversation', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-slow', title: 'Slow chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveSlowReopen!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveSlowReopen = resolve)))
        .mockResolvedValueOnce({});
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // First pick of conv-slow — still pending, stays on History.
      await user.click(await screen.findByRole('button', { name: 'select-conv-slow' }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();

      // Second pick of the SAME conversation, on the SAME pane, before the
      // first resolves — its own reopen resolves immediately and legitimately
      // lands it in the pane.
      await user.click(await screen.findByRole('button', { name: 'select-conv-slow' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-slow'));

      // NOW the first (stale) reopen resolves — must NOT close conv-slow,
      // since a pane is currently showing it.
      resolveSlowReopen({});
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('conv-slow');
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-slow');
    });

    // review finding — chatgpt-codex-connector on PR #2299: History-delete
    // deactivates the CANONICAL row, not just the deleting pane's own
    // listing — every pane showing that id (in this grid), whichever pane's
    // History tab the delete came from, must be reset rather than left
    // pointing at a transcript that now 404s on send.
    it("resets every pane showing a conversation deleted from another pane's History tab back to the picker", async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-doomed', title: 'Doomed chat', sessionId: null }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Doomed chat',
          targetId: 'conv-doomed',
          agentPageId: 'agent-1',
        }),
      );

      const user = userEvent.setup();
      const historyTabs = await screen.findAllByRole('tab', { name: /history/i });
      await user.click(historyTabs[0]);
      await user.click(await screen.findByRole('button', { name: 'delete-conv-doomed' }));

      await waitFor(() => {
        const secondPaneAfter = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === secondPaneId);
        expect(secondPaneAfter?.scope).toBeNull();
      });
    });

    // review finding — chatgpt-codex-connector and coderabbitai on PR #2299:
    // deleteConversation used to resolve regardless of outcome, so a REFUSED
    // delete (the never-empty guard's 409) still reset every pane showing
    // it, discarding a working binding for a conversation the server never
    // actually deleted.
    it('does NOT reset panes when the History delete is refused (a 409)', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-doomed', title: 'Doomed chat', sessionId: null }]);
        }
        if (url === '/api/ai/page-agents/agent-1/conversations/conv-doomed') {
          return { ok: false, json: async () => ({ error: 'last conversation', reason: 'last_conversation' }) };
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Doomed chat',
          targetId: 'conv-doomed',
          agentPageId: 'agent-1',
        }),
      );

      const user = userEvent.setup();
      const historyTabs = await screen.findAllByRole('tab', { name: /history/i });
      await user.click(historyTabs[0]);
      await user.click(await screen.findByRole('button', { name: 'delete-conv-doomed' }));

      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          '/api/ai/page-agents/agent-1/conversations/conv-doomed',
          expect.objectContaining({ method: 'DELETE' }),
        ),
      );
      const secondPaneAfter = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === secondPaneId);
      expect(secondPaneAfter?.scope?.targetId).toBe('conv-doomed');
    });

    // review finding — chatgpt-codex-connector on PR #2299: reading the
    // workspace SNAPSHOT captured when the callback was created (rather than
    // fresh at completion time) meant a pane reassigned WHILE the DELETE was
    // in flight still got reset based on its old, no-longer-current binding.
    it('does not reset a pane that was reassigned to something else while the History delete was in flight', async () => {
      let resolveDelete!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-doomed', title: 'Doomed chat', sessionId: null }]);
        }
        if (url === '/api/ai/page-agents/agent-1/conversations/conv-doomed') {
          return new Promise((resolve) => (resolveDelete = () => resolve({ ok: true })));
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Doomed chat',
          targetId: 'conv-doomed',
          agentPageId: 'agent-1',
        }),
      );

      const user = userEvent.setup();
      const historyTabs = await screen.findAllByRole('tab', { name: /history/i });
      await user.click(historyTabs[0]);
      await user.click(await screen.findByRole('button', { name: 'delete-conv-doomed' }));
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          '/api/ai/page-agents/agent-1/conversations/conv-doomed',
          expect.objectContaining({ method: 'DELETE' }),
        ),
      );

      // The user reassigns the SECOND pane to something else while the
      // DELETE is still pending.
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Something else',
          targetId: 'conv-something-else',
          agentPageId: 'agent-1',
        }),
      );

      // NOW the delete resolves — must not clobber the newer assignment.
      // No `affectedPanes` remain (the pane no longer shows conv-doomed),
      // so nothing else to await on directly — poll the pane's own scope
      // instead, giving the delete's `.then()` chain time to run and
      // confirming it stays put once it has.
      resolveDelete();
      await waitFor(() => {
        const secondPaneAfter = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === secondPaneId);
        expect(secondPaneAfter?.scope?.targetId).toBe('conv-something-else');
      });
    });

    // review finding — coderabbitai on PR #2299: `showSettings` hides the tab
    // once agentPageId becomes null, but a stuck `activeTab: 'settings'` fell
    // through to a spinner branch that could never resolve for the Assistant.
    it('resets away from the Settings tab when the pane switches to a different agent', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockPost.mockResolvedValue({});
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /researcher settings/i }));
      await screen.findByTestId('pane-settings-tab');

      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByRole('menuitem', { name: /Writer/ }));

      await waitFor(() => expect(screen.getAllByTestId('pane-chat').length).toBeGreaterThan(0));
      expect(screen.queryByTestId('pane-settings-tab')).not.toBeInTheDocument();
    });

    // review finding — chatgpt-codex-connector on PR #2299: PageAgentSettingsTab
    // registers submitForm before its own config-loaded check returns, and its
    // form defaults contain an empty prompt/tool list — clicking Save before
    // agentConfig arrives would PATCH those defaults over the agent's real
    // config.
    it('disables the Save button until the agent config has finished loading', async () => {
      let resolveConfig!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/pages/agent-1/agent-config') {
          return new Promise((resolve) => {
            resolveConfig = () => resolve(jsonOk({ systemPrompt: '', enabledTools: [], availableTools: [] }));
          });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const settingsTab = await screen.findByRole('tab', { name: /researcher settings/i });
      await userEvent.click(settingsTab);
      await screen.findByTestId('pane-settings-tab');

      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();

      resolveConfig();
      await waitFor(() => expect(saveButton).not.toBeDisabled());
    });

    it("is disabled until THIS session's entry appears in the switch decision's own data", async () => {
      let resolveSessions!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) {
          return new Promise((resolve) => {
            resolveSessions = () => resolve(jsonOk({ sessions: [{ sessionId: 'ses-1', conversations: [] }] }));
          });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const button = await screen.findByRole('button', { name: /Researcher/ });
      expect(button).toBeDisabled();

      resolveSessions();
      await waitFor(() => expect(button).not.toBeDisabled());
    });

    it('stays disabled when the initial sessions fetch fails outright (SWR isLoading goes false with no data)', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) return { ok: false, status: 500, json: async () => ({}) };
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const button = await screen.findByRole('button', { name: /Researcher/ });
      // Give SWR's failed fetch time to settle (isLoading -> false) — the
      // gate must not key off that; it must still see no data for THIS
      // session and stay disabled.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(button).toBeDisabled();
    });

    it('stays disabled when the shared drive-level cache is already warm but does not yet list THIS session (a session spawned after the last successful fetch)', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) {
          // Warm cache, real data, but for a DIFFERENT session — exactly
          // what a shared per-drive SWR key can already hold when a brand
          // new session opens.
          return jsonOk({ sessions: [{ sessionId: 'some-other-session', conversations: [] }] });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/api/agent-sessions?driveId=drive-1')),
      );

      expect(await screen.findByRole('button', { name: /Researcher/ })).toBeDisabled();
    });

    it('selecting the pane\'s current agent again is a no-op', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));

      expect(mockPost).not.toHaveBeenCalled();
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
        targetId: 'conv-1',
        agentPageId: 'agent-1',
      });
    });

    it('switching to an agent the session already has a conversation with focuses it, without minting', async () => {
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-existing-2', agentPageId: 'agent-2' },
      ]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByText('Writer'));

      expect(mockPost).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'conv-existing-2',
          agentPageId: 'agent-2',
        }),
      );
      expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-existing-2');
    });

    it('switching to an agent with no conversation in this session mints one, same as the split picker', async () => {
      mockPost.mockResolvedValue({});
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByText('Writer'));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-2/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('new-id-1'));
    });

    it('records the freshly minted conversation locally, so switching straight back to it focuses rather than mints again', async () => {
      mockPost.mockResolvedValue({});
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByText('Writer'));
      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('new-id-1'));

      // Switch back to the ORIGINAL agent, then forward to the one just
      // minted — all inside the SWR poll's 20s window, with the sessions
      // endpoint still answering its ORIGINAL (pre-mint) fixture. Without a
      // local record of the mint, this reaches `selectPaneAgent` with a list
      // that still doesn't know agent-2 has a thread — a second mint.
      await user.click(await findEnabledSelector(/Writer/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'conv-1',
        }),
      );

      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByRole('menuitem', { name: /Writer/ }));

      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'new-id-1',
          agentPageId: 'agent-2',
        }),
      );
      // Exactly the one mint from the first switch — the second forward
      // switch focused the recorded conversation instead of minting again.
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it("records a closed conversation's removal locally, so another pane's selector mints fresh instead of silently reopening it", async () => {
      // The mirror of the mint test above: without a local record of the
      // close, `selectPaneAgent`'s switch decision (read from ANOTHER pane's
      // own selector) still sees the just-closed row as open inside the SWR
      // poll's 20s window — `focus` reopens a conversation the server
      // already considers closed, outside the History reopen flow entirely
      // (caught in review).
      mockSessionConversations([
        { conversationId: 'conv-1', agentPageId: 'agent-1' },
        { conversationId: 'conv-2', agentPageId: 'agent-2' },
      ]);
      mockDel.mockResolvedValue(undefined);
      mockPost.mockResolvedValue({});
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', firstPaneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'conv-2',
          agentPageId: 'agent-2',
        }),
      );
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      act(() =>
        useAgentWorkspaceStore.getState().assignPane('ses-1', secondPaneId, {
          kind: 'chat',
          name: 'Conversation',
          targetId: 'conv-1',
          agentPageId: 'agent-1',
        }),
      );
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));

      // Close the pane showing conv-1 (agent-1) — the OTHER pane (conv-2)
      // keeps the grid non-empty, so this is an ordinary scoped close.
      const closeButtons = screen.getAllByLabelText('Close pane');
      const user = userEvent.setup();
      await user.click(closeButtons[1]);
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));

      // From the REMAINING pane, switch to agent-1 — the one whose
      // conversation JUST closed. This must MINT a fresh one, not silently
      // reopen conv-1 via a stale `focus` decision.
      await user.click(await findEnabledSelector(/Writer/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
    });

    it('records a freshly minted GLOBAL ASSISTANT conversation locally too (agentPageId: null), so switching back focuses rather than re-mints', async () => {
      mockPost.mockResolvedValue({});
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByRole('menuitem', { name: 'Global Assistant' }));
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations', {
          conversationId: 'new-id-1',
        }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('new-id-1'));

      // Same race as the named-agent case, for the null-agentPageId branch:
      // switch away then back inside the poll window, sessions fixture
      // never updated.
      await user.click(await findEnabledSelector(/Global Assistant/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'conv-1',
        }),
      );

      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByRole('menuitem', { name: /Global Assistant/ }));

      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'new-id-1',
          agentPageId: null,
        }),
      );
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it("disables the selector while the pane's chat is streaming", async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      usePendingStreamsStore.getState().addStream({
        messageId: 'msg-1',
        pageId: 'agent-1',
        conversationId: 'conv-1',
        isOwn: true,
        triggeredBy: { userId: 'user-1', displayName: 'You' },
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      // Let the (now-loaded) conversation list rule itself out as the cause,
      // isolating the assertion to the streaming guard.
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/api/agent-sessions?driveId=drive-1')),
      );

      expect(await screen.findByRole('button', { name: /Researcher/ })).toBeDisabled();
    });
  });
});
