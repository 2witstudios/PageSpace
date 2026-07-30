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

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });

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
  mockUsePageAgents.mockReturnValue({
    allAgents: [
      { id: 'agent-1', title: 'Researcher', driveId: 'drive-1' },
      { id: 'agent-2', title: 'Writer', driveId: 'drive-1' },
    ],
    isLoading: false,
  });
  mockFetchWithAuth.mockResolvedValue(jsonOk({ shells: [] }));
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
});
