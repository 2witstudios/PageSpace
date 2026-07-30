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

const mockUsePageAgents = vi.fn(() => ({
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
    it('asks for confirmation rather than closing immediately', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(mockDel).not.toHaveBeenCalled();
      // Nothing was mutated yet — the grid is still exactly what it was.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
    });

    it('cancelling leaves the session and the grid untouched', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(mockDel).not.toHaveBeenCalled();
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('confirming DELETEs the session, THEN drops the grid and reports it ended', async () => {
      mockDel.mockResolvedValue(undefined);
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

    it('a failed DELETE leaves the grid exactly as it was — no rollback needed because nothing moved', async () => {
      mockDel.mockRejectedValue(new Error('sandbox teardown failed'));
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

    it("ends the session (via forgetWorkspace) when closing the session's LAST open listing, even with a terminal pane remaining", async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockResolvedValue(undefined);
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
