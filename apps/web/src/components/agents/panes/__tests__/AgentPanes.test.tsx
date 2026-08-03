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
    onCreateNew,
    onDeleteConversation,
  }: {
    conversations: Array<{ id: string; title: string | null; sessionId: string | null }>;
    onSelectConversation: (id: string) => void;
    onCreateNew: () => void;
    onDeleteConversation: (id: string) => void;
  }) => (
    <div data-testid="pane-history-tab">
      {conversations.length} conversations
      <button onClick={() => onCreateNew()}>create-new-from-history</button>
      {conversations.map((c) => (
        <div key={c.id}>
          <button onClick={() => onSelectConversation(c.id)}>select-{c.id}</button>
          <button onClick={() => onDeleteConversation(c.id)}>delete-{c.id}</button>
        </div>
      ))}
    </div>
  ),
  PageAgentSettingsTab: ({
    pageId,
    config,
    onDirtyChange,
    onSaved,
  }: {
    pageId: string;
    config: unknown;
    onDirtyChange?: (isDirty: boolean) => void;
    onSaved?: () => void;
  }) => (
    <div data-testid="pane-settings-tab" data-page-id={pageId} data-has-config={String(config !== null)}>
      <button onClick={() => onDirtyChange?.(true)}>mark-dirty</button>
      {/* Named to avoid the substring "save" — it would otherwise collide
          with `getByRole('button', { name: /save/i })` queries for the
          host's real Save button. */}
      <button
        onClick={() => {
          // Mirrors the real component: a successful save resets the form
          // (dirty -> false) around the same time onSaved fires.
          onDirtyChange?.(false);
          onSaved?.();
        }}
      >
        finish-config-update
      </button>
    </div>
  ),
}));

import AgentPanes from '../AgentPanes';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { __resetHydratedSessionsForTests } from '@/stores/agent-workspace/useWorkspaceServerSync';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });

/**
 * The default routing every test starts from: empty shells, an empty
 * session-conversations list (both `selectPaneAgent`'s switch-decision data
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
  // `useWorkspaceServerSync`'s "hydrated this session already" tracking is
  // module-level (deliberately survives real remounts — see its own
  // comment); reset it so one test's mount doesn't suppress another's.
  __resetHydratedSessionsForTests();
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

    it('confirming drops the grid instantly, DELETEs the session, and reports it ended', async () => {
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

    it('drops the grid instantly — before the sandbox-kill DELETE resolves, not after', async () => {
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      let resolveSessionDel!: (value: unknown) => void;
      mockDel.mockImplementation((url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-1') {
          return Promise.reject(new ApiRequestError('conflict', 409));
        }
        return new Promise((resolve) => {
          resolveSessionDel = resolve;
        });
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');

      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
      // Still pending — the sandbox-kill DELETE has not resolved yet, but the
      // grid is already gone.
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeUndefined();
      expect(screen.queryByTestId('pane-chat')).not.toBeInTheDocument();

      resolveSessionDel({ hadOtherOpenConversations: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("does not kill the peeked pane's own shell until the session-end DELETE actually resolves", async () => {
      // A lone TERMINAL pane (no conversation of its own) — closing it is a
      // direct `end-session` decision, no conversation-listing DELETE first.
      // The session's own (empty) listing must be CONFIRMED-known, not merely
      // absent, or the close decision can't verify there's nothing to rebind.
      mockSessionConversations([]);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', paneId, { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toBeInTheDocument());

      let resolveSessionDel!: (value: unknown) => void;
      mockDel.mockImplementation((url: string) =>
        url === '/api/agent-sessions/ses-1'
          ? new Promise((resolve) => {
              resolveSessionDel = resolve;
            })
          : Promise.resolve(undefined),
      );
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1'));
      // Still pending — the shell must not be touched before the session-end
      // DELETE is known to have actually succeeded (review finding —
      // chatgpt-codex-connector on PR #2318).
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9');

      resolveSessionDel({ hadOtherOpenConversations: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Only now, confirmed, is the shell actually torn down.
      expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9');
    });

    it('never kills the shell at all if the session-end DELETE fails', async () => {
      mockSessionConversations([]);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', paneId, { kind: 'terminal', name: 'shell-1', targetId: 'shell-9', agentPageId: null }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-shell')).toBeInTheDocument());

      mockDel.mockImplementation((url: string) =>
        url === '/api/agent-sessions/ses-1'
          ? Promise.reject(new Error('sandbox teardown failed'))
          : Promise.resolve(undefined),
      );
      const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '');
      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'End session' }));

      await waitFor(() => expect(errorSpy).toHaveBeenCalled());
      // Never touched — a failed session-end must never have killed the
      // shell a restored terminal pane still claims to hold.
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9');
      expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined();
      expect(screen.getByTestId('pane-shell')).toBeInTheDocument();
      errorSpy.mockRestore();
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

    it('a failed DELETE rolls the grid back to exactly what it was', async () => {
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
      // The grid dropped optimistically the instant "End session" was
      // confirmed, then the DELETE failed — `hydrateWorkspace` restores it
      // from the pre-close snapshot rather than leaving it gone. No second
      // session gets minted because nothing here ever creates one.
      await waitFor(() => expect(useAgentWorkspaceStore.getState().workspaces['ses-1']).toBeDefined());
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

    it('rebinds the grid-last pane onto another OPEN listing that has no pane here, instead of falling back to the picker or ending the session', async () => {
      // conv-2 is a real open listing elsewhere in the SESSION with no pane
      // of its own in THIS grid (e.g. a background worker minted it, or
      // another tab is showing it) — the grid-never-empties rule means
      // closing this pane's own conversation repoints it at that other
      // listing rather than vanishing to a blank picker.
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
      // The grid never emptied — still exactly one pane, now repointed at
      // the other session's other open listing instead of the picker.
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-2'));
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);
    });

    it("resets the grid-last pane to its picker — not a stale no-op — when the DELETE succeeds despite the client's OWN snapshot showing nothing to rebind to", async () => {
      // The client's own listing snapshot shows conv-1 as the ONLY open
      // conversation (nothing to rebind to) — `decideClosePane` still
      // attempts the real DELETE rather than pre-guessing end-session (the
      // server is the authority), and here it SUCCEEDS: the server must
      // have known about another open listing this stale client snapshot
      // didn't. `closePane` refuses to remove a grid's only pane (the
      // never-empty invariant), so blindly calling it here would silently
      // no-op and leave this pane's scope pointed at the conversation that
      // just closed, forever — it must reset to the picker instead (review
      // finding — coderabbitai on PR #2308).
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(screen.getByLabelText('Close pane'));

      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope).toBeNull();
      });
      // Still exactly one pane (the grid never empties) — just unbound now.
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

    it('rebinds a lone TERMINAL pane onto another real open listing that has no pane here, instead of asking to end the session', async () => {
      // conv-2 is a real open listing with NO pane anywhere in this grid
      // (e.g. a background worker minted it). A terminal addresses no
      // conversation of its own, so there is nothing here to DELETE — but
      // the grid-never-empties rule still applies: with another open
      // listing available, this pane repoints at it (killing the shell it
      // was showing) rather than asking to end the session.
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

      // No confirm dialog — the grid still has an open listing to fall back
      // to. The terminal's own shell is killed as part of the rebind (the
      // conversation DELETE route is never called — there was no
      // conversation of its own to close).
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-2'));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/shells/shell-9');
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1');
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

    // review finding — chatgpt-codex-connector on PR #2299 (round 23): the
    // round-10 fix bumped the closing pane's assignment token BEFORE
    // deciding what the close actually does — including when the decision
    // turns out to be a no-op (the grid-last pane's session-conversation
    // listing hasn't resolved yet, so decideClosePane can't safely act).
    // Invalidating a pending mint's token for a close that never actually
    // happened left the mint's own completion treating itself as
    // superseded, discarding its result without ever moving the pane out
    // of its loading state — stuck spinning forever for nothing.
    it('does not invalidate a pending mint when closing turns out to be a no-op (listing not yet resolved)', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url.includes('/api/agent-sessions')) {
          // Never resolves — closeDecisionListing stays null the whole test.
          return new Promise(() => {});
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveMint!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // mint pending

      // Close the pane WHILE the mint is pending and the listing hasn't
      // resolved — the grid's only pane, so this is a no-op (nothing to
      // fall back to is confirmed yet).
      await user.click(screen.getByLabelText('Close pane'));
      // Still there — a no-op close doesn't remove anything.
      expect(
        useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
      ).toHaveLength(1);

      // The mint then succeeds — must land normally, not be discarded as
      // "superseded" by the no-op close attempt.
      resolveMint({});
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('new-id-1');
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/new-id-1');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 13): unlike
    // the picker-flow test above (nothing to lose), "New Conversation" picked
    // from a pane's OWN History tab starts from a pane already showing a
    // real, working conversation. The unconditional reset-to-picker on
    // failure lost that conversation to a blank picker for no reason — a
    // transient failure (session full, network drop) should not cost the
    // user a working conversation they never asked to leave.
    it('given "New Conversation" from History fails, restores the prior working conversation instead of resetting to the picker', async () => {
      mockPost.mockRejectedValue(new Error('session full'));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' }));

      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        // Restored to the ORIGINAL working conversation, not reset to a
        // blank picker and not left on the failed mint's loading sentinel.
        expect(pane?.scope?.targetId).toBe('conv-1');
      });
      // Stayed on History — the failed create never landed, so the tab
      // switch to Chat that would follow a successful one never fires.
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 14): two
    // mints for the SAME pane install the identical, indistinguishable
    // loading scope — without a per-call token, the OLDER one's failure
    // could restore over the NEWER one's still-pending (and about to
    // succeed) mint, which then finds itself "superseded" and discards its
    // own just-created row.
    it('given New Conversation is clicked twice before either settles, an older rejection does not clobber the still-pending newer mint', async () => {
      let rejectOlder!: (reason: unknown) => void;
      let resolveNewer!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((_resolve, reject) => (rejectOlder = reject)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveNewer = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // older, pending
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // newer, pending

      // The OLDER mint rejects first — must be a no-op (superseded), not a
      // restore, since the newer mint is still pending and about to land.
      rejectOlder(new Error('transient'));
      await act(async () => {
        await Promise.resolve();
      });

      // The NEWER mint then succeeds — must land normally.
      resolveNewer({});
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('new-id-2');
      });
      // Not cleaned up as if it had been superseded.
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/new-id-2');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 15): the
    // round-13 restore-on-failure fix re-read "the pane's live scope" fresh
    // at the start of EVERY mint call — for a SECOND overlapping mint,
    // that live scope is already the FIRST mint's own loading sentinel, not
    // the true original conversation. A failed second mint then "restored"
    // that sentinel, leaving the pane stuck spinning forever.
    it('given New Conversation is clicked twice before either settles and BOTH fail, restores the TRUE original conversation, not an intermediate loading sentinel', async () => {
      let rejectOlder!: (reason: unknown) => void;
      let rejectNewer!: (reason: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((_resolve, reject) => (rejectOlder = reject)))
        .mockReturnValueOnce(new Promise((_resolve, reject) => (rejectNewer = reject)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // older, pending
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // newer, pending

      // The OLDER mint rejects first — superseded, no-op.
      rejectOlder(new Error('transient'));
      await act(async () => {
        await Promise.resolve();
      });

      // The NEWER (current) mint then ALSO rejects — must restore the
      // ORIGINAL conv-1, not the older mint's own loading sentinel.
      rejectNewer(new Error('session full'));
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('conv-1');
      });
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 14): the
    // pane's captured priorScope can itself go stale — if the conversation
    // it points at is deleted from History (elsewhere) while this mint is
    // still pending, restoring it on failure would bind the pane to a
    // transcript that already 404s on send.
    it('given the prior conversation is deleted from History while New Conversation is pending and the mint then fails, resets to the picker instead of restoring the deleted conversation', async () => {
      // Inline fixture — `conversationsFixture` below is scoped to a
      // different (later) describe block.
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return jsonOk({
            conversations: [
              {
                id: 'conv-1',
                title: 'Conversation',
                preview: '',
                createdAt: new Date('2026-01-01').toISOString(),
                updatedAt: new Date('2026-01-01').toISOString(),
                messageCount: 1,
                sessionId: null,
                lastMessage: { role: 'user', timestamp: new Date('2026-01-01').toISOString() },
              },
            ],
          });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let rejectMint!: (reason: unknown) => void;
      mockPost.mockReturnValue(new Promise((_resolve, reject) => (rejectMint = reject)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Confirm the History list (including conv-1) has actually loaded
      // before starting the mint below.
      await screen.findByRole('button', { name: 'delete-conv-1' });
      await user.click(await screen.findByRole('button', { name: 'create-new-from-history' })); // mint pending

      // The prior conversation (conv-1) is deleted from History while the
      // mint above is still pending — the pane's own scope is the generic
      // loading sentinel at this point, so the delete's own affected-panes
      // scan can't identify and reset this pane directly.
      await user.click(await screen.findByRole('button', { name: 'delete-conv-1' }));
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations/conv-1', { method: 'DELETE' }),
      );

      // NOW the mint fails — must NOT restore the pane to the just-deleted
      // conv-1; falls back to the picker instead.
      rejectMint(new Error('quota exceeded'));
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).not.toBe('conv-1');
      });
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

    describe('hostConversationId — the hosting AI_CHAT page drops duplicate chrome for its own pane only', () => {
      it('drops to a plain label (no selector, no tab strip) when this pane IS the host conversation, keeping split/close', async () => {
        renderPanes({ hostConversationId: 'conv-1' });
        await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

        expect(screen.queryByRole('button', { name: /Researcher/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
        expect(screen.getByLabelText('Split right')).toBeInTheDocument();
        expect(screen.getByLabelText('Close pane')).toBeInTheDocument();
      });

      // Review finding: matching by AGENT instead of CONVERSATION would also
      // collapse a split pane the user deliberately pointed at a SECOND,
      // distinct conversation of the same agent — silently stripping its
      // only in-grid way to be retargeted (AISelector) or to reach its own
      // History/Settings (PaneChatTabStrip), even though the page's own
      // header isn't showing that conversation. Matching by conversation id
      // instead keeps that pane fully functional.
      it('keeps its own selector + tab strip for a split pane on a DIFFERENT conversation of the SAME agent as the host', async () => {
        renderPanes({ hostConversationId: 'conv-1' });
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
            name: 'Other conversation',
            targetId: 'conv-other',
            agentPageId: 'agent-1',
          }),
        );

        await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));
        // Exactly one match each — the FIRST (host) pane stays a plain label;
        // only the SECOND (different conversation) pane still has these.
        expect(screen.getByRole('button', { name: /Researcher/ })).toBeInTheDocument();
        expect(screen.getByRole('tablist')).toBeInTheDocument();
      });
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

    const conversationsFixture = (
      entries: Array<{ id: string; title: string; sessionId: string | null; isOwner?: boolean }>,
    ) =>
      jsonOk({
        conversations: entries.map((e) => ({
          id: e.id,
          title: e.title,
          preview: '',
          createdAt: new Date('2026-01-01').toISOString(),
          updatedAt: new Date('2026-01-01').toISOString(),
          messageCount: 1,
          sessionId: e.sessionId,
          // Every existing fixture entry represents the test's own caller's
          // conversation unless a test opts a shared/foreign one in —
          // defaulting true keeps every pre-existing claim-branch test
          // exercising the SAME path it always has.
          isOwner: e.isOwner ?? true,
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

    // issue #2295: a pane the user closed out of this session
    // (`closedInSessionAt`) must never be silently overwritten by an
    // unrelated LATER conversation selection — e.g. clicking a different
    // row in the past-conversations list, or the sidebar's session
    // re-entry, both of which funnel into the seeding effect that fires
    // `openConversation` on an `initialConversation` prop change. `conv-1`
    // is deliberately absent from the live listing below to simulate it.
    it('does not evict a pane showing a conversation absent from the live listing when a different conversation is selected', async () => {
      mockSessionConversations([{ conversationId: 'conv-2', agentPageId: 'agent-1' }]);
      const { rerender } = renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      // Wait for the session's own entry to have actually appeared in the
      // switch-decision cache — the same readiness signal `findEnabledSelector`
      // above waits on — so the seeding effect's `liveConversationIds` is
      // populated from real data rather than racing an unresolved fetch.
      await waitFor(() => expect(screen.getByRole('button', { name: /Researcher/ })).not.toBeDisabled());

      rerender(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <AgentPanes
            sessionId="ses-1"
            driveId="drive-1"
            initialConversation={{ conversationId: 'conv-2', agentPageId: 'agent-1', name: 'Conversation 2' }}
          />
        </SWRConfig>,
      );

      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));
      const shown = screen.getAllByTestId('pane-chat').map((el) => el.textContent);
      expect(shown).toContain('conv-1');
      expect(shown).toContain('conv-2');
    });

    // review finding — chatgpt-codex-connector on PR #2307: before THIS
    // session's own entry has appeared in the switch-decision cache (a cold
    // reload, a slow fetch, or one that never resolves), `sessionKnownToConversationsCache`
    // reads false. The seeding effect must not fall back to the OLD
    // unprotected eviction behavior in that window — that would reopen the
    // exact race issue #2295 fixes on every cold load — and once the fetch
    // DOES resolve, the deferred decision must still run (protected) rather
    // than leaving the pane stuck on stale data forever.
    it('defers the eviction decision (rather than evicting unprotected) while the live listing has not resolved, then finishes it once it does', async () => {
      let resolveSessions!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        // The sessions-LISTING endpoint specifically (`?driveId=`) — not the
        // per-session `/workspace` sub-route `useWorkspaceServerSync` also
        // fetches (same prefix, see the readiness test above this block).
        if (url.includes('/api/agent-sessions?')) {
          return new Promise((resolve) => {
            resolveSessions = () =>
              resolve(
                jsonOk({
                  sessions: [
                    { sessionId: 'ses-1', conversations: [{ conversationId: 'conv-2', agentPageId: 'agent-1', lastMessageAt: null }] },
                  ],
                }),
              );
          });
        }
        return jsonOk(defaultFetchRoute(url));
      });
      // A pre-existing grid — e.g. restored from persisted storage — already
      // showing conv-1, before this mount's seeding effect (targeting
      // conv-2) ever runs.
      useAgentWorkspaceStore
        .getState()
        .ensureWorkspace('ses-1', { kind: 'chat', name: 'Existing', targetId: 'conv-1', agentPageId: 'agent-1' });

      renderPanes({ initialConversation: { conversationId: 'conv-2', agentPageId: 'agent-1', name: 'Conversation 2' } });

      // The listing fetch hasn't resolved yet — the effect must have
      // deferred rather than evicting conv-1's pane unprotected.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getAllByTestId('pane-chat')).toHaveLength(1);
      expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1');

      resolveSessions();

      // conv-1 is absent from the resolved live listing (closed-in-session):
      // the deferred decision runs protected — conv-1's pane survives, conv-2
      // opens in a split rather than evicting it.
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')).toHaveLength(2));
      const shownAfter = screen.getAllByTestId('pane-chat').map((el) => el.textContent);
      expect(shownAfter).toContain('conv-1');
      expect(shownAfter).toContain('conv-2');
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
      // Unbound (`conv-fast`) now needs a real claim call too, distinct from
      // the deliberately-slow reopen this test is exercising — only the
      // reopen URL stays pending; the claim resolves normally.
      mockPost.mockImplementation((url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-slow/reopen') {
          return new Promise((resolve) => (resolveSlowReopen = resolve));
        }
        return Promise.resolve({ ok: true, alreadyInSession: false });
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Starts the slow reopen — still pending, so the pane stays on History
      // (per the previous fix) rather than following it to Chat.
      await user.click(await screen.findByRole('button', { name: 'select-conv-slow' }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();

      // A second pick on the SAME pane, before the first resolves — unbound,
      // so it claims (resolving promptly per the mock above) rather than
      // reopening, and lands quickly.
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

    // review finding — final adversarial pass on PR #2302: a pane's History
    // list routinely also contains OTHER users' shared, still-unbound
    // conversations (the list route's own `isShared` clause). Claiming one
    // of those 404s (the claim primitive's ownership gate refuses a foreign
    // row), which used to strand the pick on the History tab entirely
    // instead of opening the shared transcript the old, pre-claim, cosmetic
    // way.
    it('opens a session-less SHARED conversation the caller does not own via plain assignment, never a claim', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-not-owned', title: 'Shared chat', sessionId: null, isOwner: false },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-not-owned' }));

      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-not-owned'));
      expect(mockPost).not.toHaveBeenCalledWith(
        expect.stringContaining('/conversations/conv-not-owned/claim'),
        expect.anything(),
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
      // Flush the stale completion's own continuation — without this, the
      // waitFor below can pass on its first attempt (the pane already shows
      // conv-slow from the SECOND pick) before the rollback guard even runs,
      // making the assertion below pass trivially (review finding —
      // coderabbitai on PR #2299, round 12).
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('conv-slow');
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-slow');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 15): the
    // reopen endpoint returns the same { ok: true } shape for a genuine
    // transition AND a no-op ("already_open" — the conversation was already
    // open elsewhere, e.g. another pane/tab, or an agent switch that left
    // it open unshown). Rolling back a superseded pick unconditionally
    // could close a listing this request never actually opened.
    it('does not roll back a superseded reopen whose response reports alreadyOpen (a no-op, not a transition)', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-already-open', title: 'Already open', sessionId: 'ses-1' },
            { id: 'conv-other', title: 'Other', sessionId: null },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveReopen!: (value: unknown) => void;
      // `conv-other` is unbound, so picking it now claims (a real POST) —
      // resolve that one normally; only the reopen this test exercises stays
      // pending.
      mockPost.mockImplementation((url: string) => {
        if (url === '/api/agent-sessions/ses-1/conversations/conv-already-open/reopen') {
          return new Promise((resolve) => (resolveReopen = resolve));
        }
        return Promise.resolve({ ok: true, alreadyInSession: false });
      });
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-already-open' })); // pending

      // Superseded by picking a DIFFERENT conversation on the same pane.
      await user.click(await screen.findByRole('button', { name: 'select-conv-other' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-other'));

      // The stale reopen resolves reporting alreadyOpen — this request
      // never transitioned the listing, so no cleanup DELETE should fire.
      resolveReopen({ ok: true, alreadyOpen: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-already-open');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 16): the
    // round-15 alreadyOpen early-return skipped the "am I the last settler,
    // do I need to finish a SIBLING's deferred cleanup" check entirely —
    // an alreadyOpen no-op response for the LAST pending reopen left an
    // earlier request's genuine (but deferred) transition orphaned forever.
    it("given the last-to-settle reopen reports alreadyOpen, still drains an earlier sibling's deferred cleanup", async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-shared-16', title: 'Shared', sessionId: 'ses-1' },
            { id: 'conv-other-16', title: 'Other', sessionId: null },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveOlder!: (value: unknown) => void;
      let resolveNewer!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveNewer = resolve)))
        // The third pick below is unbound, so it claims (a real POST, unlike
        // the old cosmetic-only assign) — resolve it normally.
        .mockResolvedValue({ ok: true, alreadyInSession: false });
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-shared-16' })); // older, pending
      await user.click(await screen.findByRole('button', { name: 'select-conv-shared-16' })); // newer, pending, supersedes older
      // A third pick (unbound — claims via a fresh, promptly-resolved POST)
      // supersedes the newer reopen too.
      await user.click(await screen.findByRole('button', { name: 'select-conv-other-16' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-other-16'));

      // Older resolves first, genuinely transitioning the listing —
      // deferred, since the newer reopen is still pending.
      resolveOlder({ ok: true, alreadyOpen: false });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-shared-16');

      // The newer (LAST to settle) reports alreadyOpen — its OWN outcome is
      // a no-op, but it must still drain the older's deferred cleanup.
      resolveNewer({ ok: true, alreadyOpen: true });
      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-shared-16'),
      );
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 8): the
    // "is anyone showing this?" rollback check above still misses the case
    // where the newer reopen for the SAME conversation hasn't LANDED yet
    // when the older one resolves — nothing shows it yet, but something is
    // about to. The rollback must also check for a still-in-flight reopen.
    it('does not close a conversation when an older reopen resolves first while a newer reopen for the same conversation is still pending', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-race', title: 'Race chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveOlder!: (value: unknown) => void;
      let resolveNewer!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveNewer = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Both picks fire before either reopen resolves — neither has landed.
      await user.click(await screen.findByRole('button', { name: 'select-conv-race' }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-race' }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();

      // The OLDER reopen resolves first. No pane shows conv-race yet, but
      // the newer request is still in flight — must not close it.
      resolveOlder({});
      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-race');

      // The newer reopen resolves too — legitimately lands it.
      resolveNewer({});
      await waitFor(() => {
        const pane = useAgentWorkspaceStore
          .getState()
          .workspaces['ses-1'].columns.flatMap((c) => c.panes)
          .find((p) => p.id === paneId);
        expect(pane?.scope?.targetId).toBe('conv-race');
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-race');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 17): the
    // cleanup DELETE itself can be delayed long enough for a LATER,
    // independent pick of the exact same conversation to land in a pane
    // before it reaches the server — closing a listing that is now visibly
    // displayed. cleanupOrphanedConversation must recheck after its own
    // DELETE resolves and compensate (reopen it back) if so.
    it('compensates by reopening a conversation that landed in a pane while its own delayed cleanup DELETE was still in flight', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-compensate', title: 'Compensate', sessionId: 'ses-1' },
            { id: 'conv-unbound', title: 'Unbound', sessionId: null },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveFirstReopen!: (value: unknown) => void;
      let resolveDelete!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirstReopen = resolve))) // first pick: reopen conv-compensate
        .mockResolvedValueOnce({ ok: true, alreadyInSession: false }) // unbound pick below: claim conv-unbound (a real call now)
        .mockResolvedValueOnce({ ok: true, alreadyOpen: false }); // second (fresh) pick: reopen conv-compensate again
      mockDel.mockReturnValueOnce(new Promise((resolve) => (resolveDelete = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-compensate' })); // reopen #1, pending

      // Superseded by an unbound pick — claims (a real POST, resolved
      // promptly per the mock above) rather than reopening.
      await user.click(await screen.findByRole('button', { name: 'select-conv-unbound' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-unbound'));

      // Reopen #1 resolves — genuinely orphaned (nothing shows it, nothing
      // else pending for this id) — triggers a DIRECT cleanup, DELETE
      // pending.
      resolveFirstReopen({ ok: true, alreadyOpen: false });
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-compensate'));

      // WHILE that DELETE is still in flight, a fresh pick of the SAME
      // conversation lands it back in the pane (back to History first —
      // landing conv-unbound switched the tab to Chat).
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-compensate' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-compensate'));

      // NOW the delayed cleanup DELETE resolves — must compensate by
      // reopening the conversation it just closed back out, since a pane
      // is now showing it.
      resolveDelete(undefined);
      // 2 reopen calls happened already (the first pick, the fresh second
      // pick) — the compensating call is a THIRD.
      await waitFor(() =>
        expect(
          mockPost.mock.calls.filter(
            (c) => c[0] === '/api/agent-sessions/ses-1/conversations/conv-compensate/reopen',
          ),
        ).toHaveLength(3),
      );
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 18): the
    // SAME race that motivates the compensating reopen above applies to
    // that compensating reopen itself — if IT is slow, the pane that made
    // it necessary can move on again before it lands, leaving the
    // conversation orphaned a second time with nothing left to notice.
    it('recursively re-checks and cleans up again if the pane moves on before the compensating reopen itself lands', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([
            { id: 'conv-recurse', title: 'Recurse', sessionId: 'ses-1' },
            { id: 'conv-unbound', title: 'Unbound', sessionId: null },
          ]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveFirstReopen!: (value: unknown) => void;
      let resolveFirstDelete!: (value: unknown) => void;
      let resolveCompensatingReopen!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirstReopen = resolve))) // first pick: reopen #1, pending
        .mockResolvedValueOnce({ ok: true, alreadyInSession: false }) // unbound pick below: claim (first click)
        .mockResolvedValueOnce({ ok: true, alreadyOpen: false }) // fresh second pick: reopen conv-recurse again
        .mockReturnValueOnce(new Promise((resolve) => (resolveCompensatingReopen = resolve))) // compensating reopen
        .mockResolvedValueOnce({ ok: true, alreadyInSession: false }); // unbound pick below: claim (second click)
      mockDel
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirstDelete = resolve))) // first cleanup DELETE
        .mockResolvedValueOnce(undefined); // second (recursive) cleanup DELETE
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-recurse' })); // reopen #1, pending

      // Unbound — claims (a real POST, resolved promptly per the mock above)
      // rather than reopening.
      await user.click(await screen.findByRole('button', { name: 'select-conv-unbound' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-unbound'));

      // Reopen #1 resolves, genuinely orphaned — DIRECT cleanup, DELETE
      // pending.
      resolveFirstReopen({ ok: true, alreadyOpen: false });
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-recurse'));

      // A fresh pick lands it back while that first DELETE is pending.
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-recurse' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-recurse'));

      // First DELETE resolves — triggers a compensating reopen, pending.
      resolveFirstDelete(undefined);
      await waitFor(() =>
        expect(
          mockPost.mock.calls.filter((c) => c[0] === '/api/agent-sessions/ses-1/conversations/conv-recurse/reopen'),
        ).toHaveLength(3),
      );

      // WHILE that compensating reopen is still pending, the pane moves on
      // to something else again.
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-unbound' }));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-unbound'));

      // The compensating reopen resolves — must recheck and, since nothing
      // shows conv-recurse anymore, clean it up AGAIN.
      resolveCompensatingReopen({ ok: true, alreadyOpen: false });
      await waitFor(() =>
        expect(
          mockDel.mock.calls.filter((c) => c[0] === '/api/agent-sessions/ses-1/conversations/conv-recurse'),
        ).toHaveLength(2),
      );
    });

    // review finding — chatgpt-codex-connector (PR review on this branch):
    // the SAME unbound History row clicked twice rapidly in one pane can
    // have the FIRST request land the actual claim, go stale, and see
    // "nothing shows it yet" while the SECOND (now-current) request for the
    // identical conversationId is still in flight and about to assign it.
    // Without deferring the first request's cleanup decision the same way
    // reopen does above, its cleanup DELETE could close the listing right
    // after the second request already decided nothing needed cleaning up —
    // leaving the pane displaying a conversation the session lists as
    // closed. Pins that this can no longer happen: no cleanup DELETE ever
    // fires, and the pane correctly lands on the claimed conversation.
    it('coordinates two rapid claims of the SAME unbound conversation on one pane — the stale one defers, the current one lands cleanly with no cleanup DELETE', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-double-claim', title: 'Double claim', sessionId: null }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveFirstClaim!: (value: unknown) => void;
      let resolveSecondClaim!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirstClaim = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveSecondClaim = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-double-claim' })); // claim #1, pending
      await user.click(await screen.findByRole('button', { name: 'select-conv-double-claim' })); // claim #2, pending, supersedes #1

      // Claim #1 (stale, actually transitioned the listing server-side)
      // resolves FIRST, while #2 is still pending — must defer its cleanup
      // decision rather than closing the listing #2 is about to use.
      resolveFirstClaim({ ok: true, alreadyInSession: false });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockDel).not.toHaveBeenCalled();

      // Claim #2 (current, a no-op idempotent hit of #1's own transition)
      // resolves — lands the pane, and #1's deferred cleanup marker is now
      // moot since something (this pane) shows it.
      resolveSecondClaim({ ok: true, alreadyInSession: true });
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-double-claim'));
      expect(mockDel).not.toHaveBeenCalled();
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 8): a
    // reopen can commit server-side and then have its OWN response delayed
    // long enough for the SAME conversation to be deleted from History
    // before the completion assigns it — landing a pane on a transcript
    // that already 404s on send.
    it('does not assign a pane to a conversation deleted from History while its reopen was still in flight', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-doomed-live', title: 'Doomed live chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveReopen!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolveReopen = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const paneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Reopen starts and commits server-side but its response is delayed.
      await user.click(await screen.findByRole('button', { name: 'select-conv-doomed-live' }));
      expect(screen.getByTestId('pane-history-tab')).toBeInTheDocument();

      // The SAME conversation is deleted from History before the reopen
      // above completes.
      await user.click(await screen.findByRole('button', { name: 'delete-conv-doomed-live' }));
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          '/api/ai/page-agents/agent-1/conversations/conv-doomed-live',
          { method: 'DELETE' },
        ),
      );

      // NOW the delayed reopen resolves — must NOT assign the pane to the
      // just-deleted conversation.
      resolveReopen({});
      await act(async () => {
        await Promise.resolve();
      });
      const pane = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === paneId);
      expect(pane?.scope?.targetId).not.toBe('conv-doomed-live');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 9): the
    // Set-based mark above is a SINGLE consumable flag — fine for one
    // pending reopen, but TWO panes concurrently reopening the same closed
    // conversation both need to observe the same delete, and whichever
    // completion checks first would consume it, leaving the second one
    // blind and assigning a deleted conversation anyway.
    it('rejects EVERY pending reopen for a conversation deleted from History, not just the first to check', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-shared', title: 'Shared chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveA!: (value: unknown) => void;
      let resolveB!: (value: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveA = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveB = resolve)));
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;

      const user = userEvent.setup();
      const historyTabs = await screen.findAllByRole('tab', { name: /history/i });
      await user.click(historyTabs[0]);
      await user.click(historyTabs[1]);

      // Both panes reopen the SAME conversation — both pending.
      const selectButtonsFirst = await screen.findAllByRole('button', { name: 'select-conv-shared' });
      await user.click(selectButtonsFirst[0]);
      const selectButtonsSecond = await screen.findAllByRole('button', { name: 'select-conv-shared' });
      await user.click(selectButtonsSecond[1]);

      // Deleted from History while BOTH reopens are still in flight.
      const deleteButtons = await screen.findAllByRole('button', { name: 'delete-conv-shared' });
      await user.click(deleteButtons[0]);
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(
          '/api/ai/page-agents/agent-1/conversations/conv-shared',
          { method: 'DELETE' },
        ),
      );

      // Both delayed reopens resolve — NEITHER pane may end up bound to the
      // deleted conversation.
      resolveA({});
      resolveB({});
      await act(async () => {
        await Promise.resolve();
      });
      const finalPanes = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes);
      expect(finalPanes.find((p) => p.id === firstPaneId)?.scope?.targetId).not.toBe('conv-shared');
      expect(finalPanes.find((p) => p.id === secondPaneId)?.scope?.targetId).not.toBe('conv-shared');
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 9): the
    // round-8 fix deferred cleanup when another reopen for the same
    // conversation was still pending, on the assumption that request would
    // either land it (fine) or fail leaving cleanup moot (WRONG — a failed
    // final request leaves the earlier successful-but-deferred reopen
    // dangling forever, since nothing else will ever revisit it).
    it('cleans up an earlier successful-but-deferred reopen when the final pending reopen for it fails', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-orphan', title: 'Orphan chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveOlder!: (value: unknown) => void;
      let rejectNewer!: (reason: unknown) => void;
      mockPost
        .mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
        .mockReturnValueOnce(new Promise((_resolve, reject) => (rejectNewer = reject)));
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /history/i }));
      // Two picks of the same conversation on the same pane — the second
      // supersedes the first's token.
      await user.click(await screen.findByRole('button', { name: 'select-conv-orphan' }));
      await user.click(await screen.findByRole('button', { name: 'select-conv-orphan' }));

      // The OLDER (now-superseded) reopen resolves successfully first —
      // deferred, since the newer one is still pending and nothing shows it
      // yet.
      resolveOlder({});
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockDel).not.toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-orphan');

      // The NEWER (current) reopen then fails outright — nothing else will
      // ever revisit the older one's dangling server-side success; the
      // failing settle must finish that deferred cleanup itself.
      rejectNewer(new Error('network down'));
      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-orphan'),
      );
    });

    // review finding — chatgpt-codex-connector on PR #2299 (round 10): none
    // of the close branches touched the closing pane's assignment token, so
    // a History reopen still in flight for that exact pane stayed "current"
    // even after the pane was gone — either no-oping assignPane onto a
    // removed pane (leaving an invisible open listing that consumes a
    // session cap slot forever) or, if it resolved before the close's own
    // effect, silently repurposing the pane the user just asked to close.
    it('cancels a pending History reopen when its own pane is closed before the reopen resolves', async () => {
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        if (url === '/api/ai/page-agents/agent-1/conversations') {
          return conversationsFixture([{ id: 'conv-closed-mid-close', title: 'Closed chat', sessionId: 'ses-1' }]);
        }
        return jsonOk(defaultFetchRoute(url));
      });
      let resolveReopen!: (value: unknown) => void;
      mockPost.mockReturnValue(new Promise((resolve) => (resolveReopen = resolve)));
      mockDel.mockResolvedValue(undefined);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
      const secondPaneId = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id !== firstPaneId)!.id;
      // History needs an agent context to know whose conversations to list —
      // give the second pane one without landing a conversation of its own
      // yet (the same "agent picked, mint still pending" shape handlePickAgent
      // itself produces).
      act(() =>
        useAgentWorkspaceStore
          .getState()
          .assignPane('ses-1', secondPaneId, { kind: 'chat', name: 'Conversation', targetId: null, agentPageId: 'agent-1' }),
      );

      const user = userEvent.setup();
      // Correlate the SECOND pane's own DOM subtree by content rather than
      // array/DOM order (unreliable — a `pane-bar` and its pane body are
      // siblings under one `group/pane` container; the first pane is the
      // only one ever showing "conv-1").
      await waitFor(() => expect(screen.getAllByTestId('pane-bar')).toHaveLength(2));
      const secondPaneContainer = screen
        .getAllByTestId('pane-bar')
        .map((bar) => bar.parentElement!)
        .find((container) => !container.textContent?.includes('conv-1'))!;

      await user.click(within(secondPaneContainer).getByRole('tab', { name: /history/i }));
      await user.click(
        await within(secondPaneContainer).findByRole('button', { name: 'select-conv-closed-mid-close' }),
      );

      // Close that SAME (second) pane while the reopen is still in flight —
      // a pure layout close (unbound pane, another pane still in the grid),
      // no DELETE of its own.
      await user.click(within(secondPaneContainer).getByLabelText('Close pane'));
      await waitFor(() =>
        expect(
          useAgentWorkspaceStore.getState().workspaces['ses-1'].columns.flatMap((c) => c.panes),
        ).toHaveLength(1),
      );

      // NOW the reopen resolves — must not repurpose (there is no pane left
      // to assign to) and must clean up the now-invisible open listing it
      // left behind server-side.
      resolveReopen({});
      await waitFor(() =>
        expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-closed-mid-close'),
      );
      // The surviving (first) pane was never touched by any of this.
      const survivingPane = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === firstPaneId);
      expect(survivingPane?.scope?.targetId).not.toBe('conv-closed-mid-close');
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
    // config. The Save button now stays disabled until there's actually
    // something to save, which subsumes that original guard: it can't turn
    // dirty before config has loaded, since the form has nothing of the
    // user's to differ from yet.
    it('disables the Save button until the agent config has loaded and the user has made an edit', async () => {
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
      // Config has loaded, but nothing has been edited yet — the Save
      // button only lights up once there's something to save.
      await waitFor(() => expect(screen.getByTestId('pane-settings-tab')).toHaveAttribute('data-has-config', 'true'));
      expect(saveButton).toBeDisabled();

      await userEvent.click(screen.getByRole('button', { name: 'mark-dirty' }));

      await waitFor(() => expect(saveButton).not.toBeDisabled());
    });

    // A success toast used to cover the very tab strip/buttons a user needs
    // to leave Settings with — the confirmation now shows on the Save
    // button itself instead (no toast is asserted here; there's simply
    // nothing left that would fire one).
    it('shows an inline "Saved" confirmation on the Save button, then reverts to disabled', async () => {
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toBeInTheDocument());

      await userEvent.click(await screen.findByRole('tab', { name: /researcher settings/i }));
      await screen.findByTestId('pane-settings-tab');

      const saveButton = screen.getByRole('button', { name: /save/i });
      await userEvent.click(screen.getByRole('button', { name: 'mark-dirty' }));
      expect(saveButton).not.toBeDisabled();

      await userEvent.click(screen.getByRole('button', { name: 'finish-config-update' }));

      expect(await screen.findByRole('button', { name: /saved/i })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled(), { timeout: 3000 });
    });

    it("is disabled until THIS session's entry appears in the switch decision's own data", async () => {
      let resolveSessions!: () => void;
      mockFetchWithAuth.mockImplementation(async (url: string) => {
        // The sessions-LISTING endpoint specifically (`?driveId=`) — not the
        // per-session `/workspace` sub-route `useWorkspaceServerSync` also
        // fetches, which would otherwise reassign this shared resolver to
        // the WRONG pending promise (both URLs start with the same prefix).
        if (url.includes('/api/agent-sessions?')) {
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

    it('closes the outgoing conversation on switch, so switching back mints FRESH rather than reusing the one just left', async () => {
      // The actual bug fix, from the switch side: today's model has no
      // "leave it open in the background" — a plain AISelector switch
      // always replaces the active tab, closing what it replaces (unless
      // shown elsewhere). Switching back to an agent you just left is
      // therefore a fresh mint every time, not a free rewind — that's what
      // keeps the session's open-listing set (and the sidebar) matching
      // what's actually visible, instead of accumulating every agent ever
      // visited. Pane tabs (keeping several agents' conversations alive at
      // once behind one pane) were tried and removed — see pane-reducer.ts's
      // own header comment; a pane holds exactly one conversation now.
      mockPost.mockResolvedValue({});
      mockDel.mockResolvedValue(undefined);
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      const user = userEvent.setup();
      await user.click(await findEnabledSelector(/Researcher/));
      await user.click(await screen.findByText('Writer'));
      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('new-id-1'));
      // The outgoing conversation (agent-1's original) closed.
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));

      // Switch back to the ORIGINAL agent — conv-1 is gone now, so this
      // mints a SECOND, brand-new conversation rather than reusing it.
      await user.click(await findEnabledSelector(/Writer/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'new-id-2',
          agentPageId: 'agent-1',
        }),
      );
      // And the just-left Writer conversation (new-id-1) closed in turn.
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/new-id-1'));
    });

    it('clicking "+" starts a new conversation with the pane\'s CURRENT agent, replacing what it shows — no agent picker', async () => {
      // Pane tabs are gone: the "+" chip no longer opens a dropdown to add a
      // tab. It is now the literal same operation as History's own "New
      // Conversation" button (`onCreateNewFromHistory`/`handlePickAgent`) —
      // mint fresh with THIS pane's own agent and replace what's showing.
      mockPost.mockResolvedValue({});
      mockDel.mockResolvedValue(undefined);
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Start a new conversation' }));

      // No agent picker/dropdown ever opens — nothing to choose, so no
      // "Writer" option is ever offered here.
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Writer/ })).not.toBeInTheDocument();

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('new-id-1'));
      // The replaced conversation (conv-1) closed — the same
      // closeReplacedConversation cleanup an AISelector switch triggers.
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));
    });

    it('clicking "+" does not close the replaced conversation when another pane still shows it', async () => {
      // closeReplacedConversation's "don't leak a stray open listing" rule
      // has an exception baked in: if the outgoing conversation is still
      // visibly shown in ANOTHER pane, closing it here would rip it out from
      // under that pane.
      mockPost.mockResolvedValue({});
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      const firstPaneId = useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].id;
      act(() => useAgentWorkspaceStore.getState().splitRight('ses-1', firstPaneId));
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

      const user = userEvent.setup();
      const newConversationButtons = screen.getAllByRole('button', { name: 'Start a new conversation' });
      await user.click(newConversationButtons[0]);

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
          conversationId: 'new-id-1',
          sessionId: 'ses-1',
        }),
      );
      // Wait for the mint to fully land (closeReplacedConversation, if it
      // were going to run, runs as part of settling this) before asserting
      // the negative — otherwise the assertion can pass on timing alone,
      // before the async cleanup path would have had a chance to call `del`
      // (review finding — coderabbitai on PR #2308).
      await waitFor(() => expect(screen.getAllByTestId('pane-chat')[0]).toHaveTextContent('new-id-1'));
      // The SECOND pane still shows conv-1 — never closed.
      expect(mockDel).not.toHaveBeenCalled();
      const secondPaneAfter = useAgentWorkspaceStore
        .getState()
        .workspaces['ses-1'].columns.flatMap((c) => c.panes)
        .find((p) => p.id === secondPaneId);
      expect(secondPaneAfter?.scope?.targetId).toBe('conv-1');
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

    it('mints a GLOBAL ASSISTANT conversation (agentPageId: null) through the same path, closing the outgoing agent conversation', async () => {
      mockPost.mockResolvedValue({});
      mockDel.mockResolvedValue(undefined);
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
      await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-sessions/ses-1/conversations/conv-1'));

      // Switching back to Researcher mints fresh too (conv-1 is gone), same
      // "closes on switch" discipline as the null-agentPageId case's outgoing side.
      await user.click(await findEnabledSelector(/Global Assistant/));
      await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));
      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope).toMatchObject({
          targetId: 'new-id-2',
          agentPageId: 'agent-1',
        }),
      );
      expect(mockPost).toHaveBeenCalledTimes(2);
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

    it('also disables the "+" chip while the pane\'s chat is streaming — replacing it would yank a still-arriving response out from under itself', async () => {
      // Same guard the selector above gets, applied to the "+" chip: clicking
      // it replaces the pane's content and closes the outgoing conversation,
      // which for a live stream means abandoning a response (and any
      // in-flight tool work) that's still arriving, with no way back to it
      // (review finding — chatgpt-codex-connector on PR #2308).
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
      await waitFor(() =>
        expect(mockFetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/api/agent-sessions?driveId=drive-1')),
      );

      expect(await screen.findByRole('button', { name: 'Start a new conversation' })).toBeDisabled();
    });

    it('does NOT disable the "+" chip merely because a mint is already in flight for this pane — a second click is a supported, harmless race', async () => {
      // Unlike the stream guard above, a mid-mint pane must stay clickable:
      // `handlePickAgent`'s own token/counter bookkeeping is what makes two
      // overlapping mints for the same pane land safely, and this button
      // must not pre-empt that by disabling itself on `surface === 'loading'`
      // (review finding follow-up — over-guarding this identically to the
      // agent selector's `disabledAgentSwitch` broke the existing
      // "click New Conversation twice" race-condition coverage).
      mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
      mockPost.mockReturnValue(new Promise(() => {})); // never resolves — pane stays 'loading'
      renderPanes();
      await waitFor(() => expect(screen.getByTestId('pane-chat')).toHaveTextContent('conv-1'));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start a new conversation' })).not.toBeDisabled());
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Start a new conversation' }));

      await waitFor(() =>
        expect(useAgentWorkspaceStore.getState().workspaces['ses-1'].columns[0].panes[0].scope?.targetId).toBeNull(),
      );
      expect(screen.getByRole('button', { name: 'Start a new conversation' })).not.toBeDisabled();
    });
  });
});
