/**
 * AgentPanes — the container's own IO: minting conversations/shells into a
 * session, and the pane-close lifecycle (issue #2263).
 *
 * The properties worth pinning hardest: **closing the last pane is
 * confirmed and server-first** — no grid mutation happens until the DELETE
 * succeeds, so a failed teardown leaves the user exactly where they were
 * rather than spawning a second session behind their back; **a terminal pane
 * close kills its shell**; and **a pane closed mid-mint doesn't resurrect**
 * once its POST resolves. Leaf renderers (`PaneChat`, `Shell`) are mocked —
 * this suite is the container's wiring, not their internals. The real store
 * and the real pane-reducer run underneath, same as `AgentsSidebar.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

const mockPost = vi.fn();
const mockDel = vi.fn();
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  post: (...args: unknown[]) => mockPost(...args),
  del: (...args: unknown[]) => mockDel(...args),
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
 * session-conversations list (`ChatPaneIdentity`'s switch-decision data), and
 * `useResolvedAgent`'s two lookups per fixture agent (id/title come from
 * `mockUsePageAgents` above). A test that cares about a specific route
 * layers its own `mockImplementation` on top.
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
        expect(mockDel).toHaveBeenCalledWith('/api/ai/page-agents/agent-2/conversations/new-id-1'),
      );
      // Still just the one pane — the resolved mint did not resurrect it.
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
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
      mockFetchWithAuth.mockResolvedValue(jsonOk({ shells: [{ shellId: 'shell-old', name: 'build' }] }));
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
      mockFetchWithAuth.mockResolvedValue(jsonOk({ shells: [{ shellId: 'shell-bound', name: 'build' }] }));
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

    /** Every interactive test needs the switch-decision data loaded first — see the disabled-while-loading test below for why. */
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

    it('is disabled until the session conversation list — the switch decision\'s own data — has loaded at least once', async () => {
      let resolveSessions!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) {
          return new Promise((resolve) => {
            resolveSessions = () => resolve(jsonOk({ sessions: [] }));
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
