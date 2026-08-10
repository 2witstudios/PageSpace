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

// Unmocked until now, which is why the reported symptom was invisible here: a
// spurious "Could not close this conversation" toast is not observable unless
// something records the call.
const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

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
import {
  useAgentWorkspaceStore,
  __resetWorkspaceQueuesForTests,
} from '@/stores/agent-workspace/useAgentWorkspaceStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import type { PaneTarget, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeTarget } from '@pagespace/lib/agent-workspaces/workspace-node-wire';

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body });

/**
 * This session's own RECORD — `useSessionRecord`'s read, and the source of
 * `canEndSession`, which `decideClosePane` needs to know whether the last-pane
 * close may offer to end the workspace.
 *
 * Matched EXACTLY, and ahead of every `includes('/api/agent-workspaces')`
 * branch below: the listing key is a prefix of this one, so a substring test
 * would answer a record read with a `{sessions: []}` body and the flag would
 * read as absent — which is a silent false, not an error.
 */
const SESSION_RECORD_URL = '/api/agent-workspaces/ses-1';
let mockCanEndSession = true;
const sessionRecord = () => ({
  session: { driveId: 'drive-1', name: 'Session' },
  sandboxEligible: true,
  canEndSession: mockCanEndSession,
});

/**
 * The default routing every test starts from: this session's record, empty
 * shells, an empty session-conversations list (both `selectPaneAgent`'s
 * switch-decision data AND `decideClosePane`'s close-decision data), and
 * `useResolvedAgent`'s two lookups per fixture agent (id/title come from
 * `mockUsePageAgents` above). A test that cares about a specific route layers
 * its own `mockImplementation` on top, falling back to this for every other URL.
 */
function defaultFetchRoute(url: string): unknown {
  if (url === SESSION_RECORD_URL) return sessionRecord();
  if (url.includes('/shells')) return { shells: [] };
  if (url.includes('/api/agent-workspaces')) return { sessions: [] };
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
    if (url !== SESSION_RECORD_URL && url.includes('/api/agent-workspaces')) {
      return jsonOk({
        sessions: [{ workspaceId: 'ses-1', sessionId: 'ses-1', conversations: conversations.map((c) => ({ lastMessageAt: null, ...c })) }],
      });
    }
    return jsonOk(defaultFetchRoute(url));
  });
}

/**
 * Every node write this test issued, as `{put, drop}` — the ONE channel a pane
 * close is allowed to use.
 *
 * The double-send this suite failed to catch survived precisely because
 * `fetchWithAuth` (the `/nodes` POST) and `del` (the conversations DELETE) are
 * separate spies, so no assertion ever looked at both. Anything asserting that a
 * close is one write has to look across the two, which is what this and
 * {@link conversationDeletes} are for.
 */
function nodeWrites(): Array<{ put: unknown[]; drop: string[] }> {
  return mockFetchWithAuth.mock.calls
    .filter(([url, init]) => typeof url === 'string' && url.endsWith('/nodes') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body as string) as { put: unknown[]; drop: string[] });
}

/** Every conversation-scoped DELETE this test issued. */
function conversationDeletes(): string[] {
  return mockDel.mock.calls
    .map(([url]) => url as string)
    .filter((url) => typeof url === 'string' && url.includes('/conversations/'));
}

/**
 * THE CROSS-CHANNEL ASSERTION: closing a chat pane is exactly one node drop and
 * no conversation DELETE.
 */
async function expectSingleDropClose(nodeId: string) {
  await waitFor(() => expect(nodeWrites().some((write) => write.drop.includes(nodeId))).toBe(true));
  expect(nodeWrites().filter((write) => write.drop.includes(nodeId))).toHaveLength(1);
  expect(conversationDeletes()).toEqual([]);
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
  mockCanEndSession = true;
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {}, queueErrors: {} });
  usePendingStreamsStore.setState({ streams: new Map() });
  // The write queue's generation counters and retry timers are module-level
  // (they deliberately survive real remounts); reset them so one test's
  // in-flight write cannot leak into the next.
  __resetWorkspaceQueuesForTests();
  mockUsePageAgents.mockReturnValue({
    allAgents: [
      { id: 'agent-1', title: 'Researcher', driveId: 'drive-1' },
      { id: 'agent-2', title: 'Writer', driveId: 'drive-1' },
    ],
    isLoading: false,
  });
  mockFetchWithAuth.mockImplementation(async (url: string) => jsonOk(defaultFetchRoute(url)));
  // A RESOLVED PROMISE BY DEFAULT, so no test depends on another having set one.
  // `vi.clearAllMocks()` clears calls but NOT implementations, so `del` used to
  // arrive here carrying whatever `mockResolvedValue` the previous test left on
  // it — and the terminal-close test relied on that leak without saying so.
  // When the chat close stopped issuing a DELETE, the leak stopped too:
  // `closeShell`'s `void del(...).catch(...)` got `undefined` back and threw
  // inside a React event handler. Every test still passed and the RUN exited 1
  // on the unhandled error.
  mockDel.mockResolvedValue(undefined);
});


/** Seat a workspace's tree the way the listing does — there is no client seed. */
const WS = 'ses-1';
const rootNode: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };
const paneNode = (id: string, parentId: string, position: number, target: PaneTarget | null): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId,
  position,
  target,
});
const chatNode = (id: string, parentId: string, position: number, conversationId: string) =>
  paneNode(id, parentId, position, { kind: 'chat', id: conversationId });

const CONV_1_TARGET: WorkspaceNodeTarget = {
  id: 'conv-1',
  kind: 'chat',
  title: 'First chat',
  lastMessageAt: null,
  agentPageId: 'agent-1',
};

function seat(nodes: WorkspaceNode[], targets: WorkspaceNodeTarget[] = [CONV_1_TARGET]) {
  act(() => {
    useAgentWorkspaceStore.getState().hydrateFromServer(WS, { rev: 1, nodes, targets });
  });
}

const nodesNow = () => useAgentWorkspaceStore.getState().workspaces[WS]?.nodes ?? [];
const panesNow = () => nodesNow().filter((node) => node.nodeType === 'pane');
const nodeById = (id: string) => nodesNow().find((node) => node.id === id);
const nodeShowingChat = (conversationId: string) =>
  panesNow().find((node) => node.target?.kind === 'chat' && node.target.id === conversationId);

describe('AgentPanes — the grid it renders', () => {
  it('renders the chat pane for the tree it was given, with no seeding of its own', async () => {
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    renderPanes();
    expect(await screen.findByTestId('pane-chat')).toHaveTextContent('conv-1');
    // The mount-time `ensure` verb is gone with the two-level model — a
    // workspace's root is minted server-side by whatever write first needs one.
    expect(mockFetchWithAuth).not.toHaveBeenCalledWith(
      expect.stringContaining('/nodes'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  /**
   * THE EMPTY GRID. Closing the last pane destroys it and leaves the workspace
   * alive — a state the two-level model could not represent, which is why
   * browser code used to end the session instead.
   */
  it('renders the empty frame for a workspace whose grid holds nothing', async () => {
    seat([rootNode], []);
    renderPanes({ initialConversation: null });
    expect(await screen.findByTestId('empty-grid')).toBeDefined();
  });

  it('renders the empty frame for a workspace that has never been written', async () => {
    seat([], []);
    renderPanes({ initialConversation: null });
    expect(await screen.findByTestId('empty-grid')).toBeDefined();
  });

  it('titles a pane from targets[], not from anything the node carries', async () => {
    seat([rootNode, paneNode('n1', WS, 0, { kind: 'page', id: 'page-1' })], [
      { id: 'page-1', kind: 'page', title: 'Spec doc', lastMessageAt: null, agentPageId: null },
    ]);
    renderPanes({ initialConversation: null });
    expect(await screen.findByText('Spec doc')).toBeDefined();
  });

  it('still renders a pane whose target the viewer cannot resolve, under a generic name', async () => {
    // No `targets[]` entry — gone, or not this viewer's to read. The rectangle
    // is still there and must still be closable.
    seat([rootNode, paneNode('n1', WS, 0, { kind: 'page', id: 'page-1' })], []);
    renderPanes({ initialConversation: null });
    expect(await screen.findByText('Page')).toBeDefined();
  });
});

describe('AgentPanes — selection is an instruction', () => {
  it('focuses the node already showing the selected conversation', async () => {
    seat([rootNode, chatNode('n1', WS, 0, 'conv-9'), chatNode('n2', WS, 1, 'conv-1')]);
    renderPanes();
    await waitFor(() => expect(useAgentWorkspaceStore.getState().workspaces[WS]?.activeNodeId).toBe('n2'));
  });

  /**
   * A thread held DEEP in the tree. This was about a PARKED node: `open` refused
   * it deliberately, so the store had to move it back or selecting a closed
   * thread from the sidebar silently did nothing. Every holder is on screen now,
   * and the property that survives is the one that mattered — no SECOND node is
   * minted for a conversation the workspace already shows.
   */
  it('focuses a node nested below a split rather than minting a second one', async () => {
    seat([
      rootNode,
      chatNode('n1', WS, 0, 'conv-9'),
      { nodeType: 'split', id: 's1', parentId: WS, position: 1, axis: 'column' },
      chatNode('deep', 's1', 0, 'conv-1'),
      chatNode('beside', 's1', 1, 'conv-8'),
    ]);
    renderPanes();
    await waitFor(() => expect(useAgentWorkspaceStore.getState().workspaces[WS]?.activeNodeId).toBe('deep'));
    expect(panesNow().filter((node) => node.target?.kind === 'chat' && node.target.id === 'conv-1')).toHaveLength(1);
  });
});

describe('AgentPanes — closing a pane', () => {
  it('closes a chat pane with ONE node drop and no conversation DELETE', async () => {
    // THE DOUBLE-SEND REGRESSION. Both requests destroyed the same node: the
    // store's drop, POSTed to /nodes, and a DELETE whose `expel` is the same
    // destroy. The drop normally won, so the DELETE's expel found nothing,
    // answered 404, and raised a toast for a close that had already succeeded.
    // Asserted across BOTH channels, because the two are separate spies and
    // that is exactly why nothing caught it.
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findAllByTestId('pane-chat');
    await user.click(within(screen.getAllByTestId('pane-bar')[0]).getByLabelText('Close pane'));

    await expectSingleDropClose('n1');
    // DESTROYED, not parked. It used to survive with a null parent, still a
    // member holding its binding — the state that made a closed pane and a
    // broken one the same row.
    expect(nodeById('n1')).toBeUndefined();
  });

  it('shows no error toast on a successful close', async () => {
    // The reported symptom, stated directly. Unobservable before this suite
    // mocked `sonner` at all.
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findAllByTestId('pane-chat');
    await user.click(within(screen.getAllByTestId('pane-bar')[0]).getByLabelText('Close pane'));

    await waitFor(() => expect(nodeById('n1')).toBeUndefined());
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('closing a terminal pane kills its shell — a closed tab is a DELETE, not an orphan', async () => {
    seat(
      [
        rootNode,
        paneNode('n1', WS, 0, { kind: 'terminal', id: 'shell-1' }),
        chatNode('n2', WS, 1, 'conv-2'),
      ],
      [],
    );
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await screen.findByTestId('pane-shell');
    await user.click(within(screen.getAllByTestId('pane-bar')[0]).getByLabelText('Close pane'));

    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/shells/shell-1'));
    expect(nodeById('n1')).toBeUndefined();
  });

  it('does nothing while the directory has not resolved — a close never acts on an unverified fact', async () => {
    // A tree this browser SEEDED and no server answer has confirmed:
    // `runCommand` mints a root locally so the first click composes into one
    // write, so nodes can exist with nothing server-read behind them. "Not
    // confirmed" is not "confirmed and empty". Split first, so two panes exist
    // and the last-pane branch (decided ABOVE this guard) is not what answers.
    //
    // The node write must NOT settle: the pump folds a successful ack into the
    // base, which is itself a server confirmation of this tree and would
    // legitimately resolve the directory.
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/nodes')) return new Promise<never>(() => {});
      return jsonOk(defaultFetchRoute(url));
    });
    act(() => {
      useAgentWorkspaceStore.getState().openConversation(WS, 'conv-1');
    });
    const seeded = nodesNow().find((node) => node.nodeType === 'pane');
    act(() => {
      useAgentWorkspaceStore.getState().splitPane(WS, seeded!.id, 'row');
    });
    expect(useAgentWorkspaceStore.getState().workspaces[WS].hasServerSnapshot).toBe(false);

    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    const chatPaneId = nodeShowingChat('conv-1')!.id;
    const bars = screen.getAllByTestId('pane-bar');
    await user.click(within(bars[0]).getByLabelText('Close pane'));

    expect(mockDel).not.toHaveBeenCalled();
    expect(nodeById(chatPaneId)).toBeDefined();
  });

  it('is a pure layout close when the listing resolved WITHOUT this thread', async () => {
    mockSessionConversations([{ conversationId: 'conv-other', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findAllByTestId('pane-chat');
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    await user.click(within(screen.getAllByTestId('pane-bar')[0]).getByLabelText('Close pane'));

    await waitFor(() => expect(nodeById('n1')).toBeUndefined());
    expect(mockDel).not.toHaveBeenCalled();
  });
});

/**
 * CLOSING THE LAST PANE ENDS THE SESSION — restored, and decided on the client.
 *
 * It used to be the server's `last_conversation` 409 caught by the close
 * DELETE's error branch; the node-tree cutover removed that refusal, which left
 * the branch unreachable and the user stranded in an empty grid. The whole
 * decision is `decideClosePane`'s now, so the confirm is raised without any
 * request having to fail first — `mockDel` never rejects in any of these.
 */
describe('AgentPanes — closing the LAST pane', () => {
  it('raises the end-session confirm instead of emptying the grid', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(screen.getByLabelText('Close pane'));

    expect(await screen.findByRole('alertdialog')).toBeDefined();
    // NOTHING has been written yet — the confirm is the whole act so far.
    expect(nodeById('n1')).toBeDefined();
    expect(nodeWrites()).toEqual([]);
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('raises it for a lone TERMINAL pane too — the count is of panes, not of chats', async () => {
    seat([rootNode, paneNode('n1', WS, 0, { kind: 'terminal', id: 'shell-1' })], []);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await screen.findByTestId('pane-shell');
    await user.click(screen.getByLabelText('Close pane'));

    expect(await screen.findByRole('alertdialog')).toBeDefined();
    expect(mockDel).not.toHaveBeenCalledWith('/api/agent-workspaces/ses-1/shells/shell-1');
  });

  it('raises it while the listing has NOT resolved', async () => {
    // The default route never lists this workspace, so `activeConversations` is
    // null. Behind that guard the click would silently no-op; the decision is
    // taken above it.
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(screen.getByLabelText('Close pane'));

    expect(await screen.findByRole('alertdialog')).toBeDefined();
  });

  it('Cancel leaves the pane exactly where it was, having written nothing', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(screen.getByLabelText('Close pane'));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(nodeById('n1')).toBeDefined();
    expect(nodeWrites()).toEqual([]);
    expect(mockDel).not.toHaveBeenCalled();
    expect(useAgentWorkspaceStore.getState().workspaces[WS]).toBeDefined();
  });

  it('Confirm ends the session', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    mockDel.mockResolvedValue({});
    const onSessionEnded = vi.fn();
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes({ onSessionEnded });

    await screen.findByTestId('pane-chat');
    await user.click(screen.getByLabelText('Close pane'));
    await user.click(await screen.findByRole('button', { name: /end session/i }));

    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1'));
    await waitFor(() => expect(useAgentWorkspaceStore.getState().workspaces[WS]).toBeUndefined());
    expect(onSessionEnded).toHaveBeenCalled();
  });

  it('a member who may NOT end the workspace keeps the ordinary close', async () => {
    // `DELETE /api/agent-workspaces/{id}` is gated by `checkSessionEndAccess`,
    // which is stricter than the access that let them reach the pane. Offering
    // a confirm they would obey and then be refused for is worse than the empty
    // grid they had before.
    mockCanEndSession = false;
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    // Wait for the session record to land, or the flag reads as its (false)
    // default for a reason that has nothing to do with permission.
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledWith(SESSION_RECORD_URL));
    await user.click(screen.getByLabelText('Close pane'));

    await waitFor(() => expect(nodeById('n1')).toBeUndefined());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mockDel).not.toHaveBeenCalledWith('/api/agent-workspaces/ses-1');
    expect(await screen.findByTestId('empty-grid')).toBeDefined();
  });
});

describe('AgentPanes — the mint lifecycle', () => {
  /** An unbound pane, so the picker is what renders. */
  const withPicker = () => seat([rootNode, paneNode('n1', WS, 0, null)], []);

  it('mints a conversation and places it, without ever half-binding the pane', async () => {
    mockPost.mockResolvedValue({});
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
        conversationId: 'new-id-1',
        sessionId: 'ses-1',
        // The pane the user picked into — without it the server places blind.
        activeNodeId: 'n1',
      }),
    );
    await waitFor(() => expect(nodeShowingChat('new-id-1')).toBeDefined());
  });

  /**
   * THE REBIND THE MODEL DELETED. A mint used to set the pane to `{kind,
   * targetId: null}` and then to the real target; a `PaneTarget` cannot be
   * half-bound, so a failed mint leaves the pane exactly as the user left it and
   * there is nothing to restore.
   */
  it('a failed mint leaves the pane untouched — no sentinel to unwind', async () => {
    mockPost.mockRejectedValue(new Error('boom'));
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    // Untouched: still the same node, still unbound, still on the grid — and
    // back on the picker rather than stuck on a spinner.
    await waitFor(() => expect(screen.getByText('Researcher')).toBeDefined());
    expect(nodeById('n1')).toMatchObject({ target: null, parentId: WS });
    expect(panesNow()).toHaveLength(1);
  });

  /**
   * THE REGRESSION #2386-adjacent, and the one that made a second agent pane
   * unusable: a mint's OWN server write admits what it created, and admitting
   * PLACES — into this very pane, because that is what `admit` does with an
   * unbound one. The `session:<id>` broadcast binds it here before the POST
   * resolves, so the pane the user asked for arrives, and then the completion
   * handler used to read "bound" as "somebody else took this node", declare
   * itself superseded, and DELETE the conversation it had just created. The
   * pane appeared and vanished, silently, because that cleanup says nothing.
   */
  it("keeps the conversation when the mint's own admission bound this pane first", async () => {
    let resolveMint!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    mockDel.mockResolvedValue({});
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    // The broadcast for the mint's own admission — the server placed the new
    // conversation into this pane while its POST was still in flight.
    act(() => {
      useAgentWorkspaceStore.getState().applyRemoteUpdate({
        workspaceId: WS,
        rev: 2,
        nodes: [rootNode, chatNode('n1', WS, 0, 'new-id-1')],
      });
    });

    resolveMint({});

    await waitFor(() => expect(nodeShowingChat('new-id-1')).toBeDefined());
    // The whole point: nothing tears down what the mint just made.
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('lands the conversation in the pane the user picked into, not whichever was empty first', async () => {
    // TWO unbound panes. Without a placement preference the server's `open()`
    // policy falls to `panes.find(canReplace)` — the FIRST unbound pane in grid
    // order, n1 — while the user clicked n2. So the mint has to name the pane.
    seat([rootNode, paneNode('n1', WS, 0, null), paneNode('n2', WS, 1, null)], []);
    mockPost.mockResolvedValue({});
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    // The SECOND picker — the pane the user is actually looking at.
    const pickers = await screen.findAllByText('Researcher');
    await user.click(pickers[1]);

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    // The mint has to say WHERE, or the server places blind.
    expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-1/conversations', {
      conversationId: 'new-id-1',
      sessionId: 'ses-1',
      activeNodeId: 'n2',
    });
  });

  it('still cleans up when the pane was taken by something ELSE mid-mint', async () => {
    // The case the supersede check exists for, and which must survive the fix:
    // bound, but to a thread this mint did not create.
    let resolveMint!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    mockDel.mockResolvedValue({});
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    act(() => {
      useAgentWorkspaceStore.getState().applyRemoteUpdate({
        workspaceId: WS,
        rev: 2,
        nodes: [rootNode, chatNode('n1', WS, 0, 'someone-elses-thread')],
      });
    });

    resolveMint({});

    await waitFor(() =>
      expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/new-id-1'),
    );
  });

  it('holds the pane on a spinner while its mint is in flight, never a speculative terminal', async () => {
    let resolveMint!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));

    // Neither the picker nor a surface — the pane is holding.
    await waitFor(() => expect(screen.queryByText('Researcher')).toBeNull());
    expect(screen.queryByTestId('pane-shell')).toBeNull();
    expect(screen.queryByTestId('pane-chat')).toBeNull();

    resolveMint({});
    await waitFor(() => expect(nodeShowingChat('new-id-1')).toBeDefined());
  });

  it('cleans up the orphaned row when the pane is closed mid-mint', async () => {
    let resolveMint!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    mockDel.mockResolvedValue({});
    seat([rootNode, paneNode('n1', WS, 0, null), chatNode('n2', WS, 1, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Researcher'));
    // The pane leaves the grid while its POST is still on the wire.
    act(() => {
      useAgentWorkspaceStore.getState().closePane(WS, 'n1');
    });
    resolveMint({});

    await waitFor(() =>
      expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/new-id-1'),
    );
  });
});

describe('AgentPanes — the picker', () => {
  const withPicker = () => seat([rootNode, paneNode('n1', WS, 0, null)], []);

  it('opens a shell and binds the pane to it', async () => {
    mockPost.mockResolvedValue({ shell: { shellId: 'shell-9', name: 'shell-1' } });
    withPicker();
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Shell'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/shells', { activeNodeId: 'n1' }),
    );
    await waitFor(() => expect(nodeById('n1')).toMatchObject({ target: { kind: 'terminal', id: 'shell-9' } }));
  });

  it('opens the shell in the pane the user picked into, not whichever was empty first', async () => {
    // The terminal's own version of the mint's blind placement: `spawnShell`
    // ADMITS the same way a conversation does, so with two unbound panes the
    // policy falls to `panes.find(canReplace)` — n1 — while the user clicked n2.
    mockPost.mockResolvedValue({ shell: { shellId: 'shell-9', name: 'shell-1' } });
    seat([rootNode, paneNode('n1', WS, 0, null), paneNode('n2', WS, 1, null)], []);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    // The SECOND picker — the pane the user is actually looking at.
    const pickers = await screen.findAllByText('Shell');
    await user.click(pickers[1]);

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/shells', { activeNodeId: 'n2' }),
    );
  });

  it('closes a shell whose pane went away while it was being opened', async () => {
    let resolveShell!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveShell = resolve)));
    seat([rootNode, paneNode('n1', WS, 0, null), chatNode('n2', WS, 1, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });

    await user.click(await screen.findByText('Shell'));
    act(() => {
      useAgentWorkspaceStore.getState().closePane(WS, 'n1');
    });
    resolveShell({ shell: { shellId: 'shell-9', name: 'shell-1' } });

    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/shells/shell-9'));
  });

  /**
   * A shell already bound to a node ANYWHERE in the tree is not offered for
   * reattach — the list reads every pane, not only the root's own children.
   * This used to be stated with a PARKED holder, which was the only way to make
   * "somewhere the picker is not looking" interesting.
   */
  it('does not offer a shell already bound to a node nested below a split', async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('/shells')) return jsonOk({ shells: [{ shellId: 'shell-deep', name: 'deep shell' }] });
      return jsonOk(defaultFetchRoute(url));
    });
    seat(
      [
        rootNode,
        paneNode('n1', WS, 0, null),
        { nodeType: 'split', id: 's1', parentId: WS, position: 1, axis: 'column' },
        paneNode('held', 's1', 0, { kind: 'terminal', id: 'shell-deep' }),
        paneNode('beside', 's1', 1, { kind: 'page', id: 'page-1' }),
      ],
      [],
    );
    renderPanes({ initialConversation: null });

    await screen.findByText('Researcher');
    expect(screen.queryByText('deep shell')).toBeNull();
  });

  it('binds a page directly, with no mint', async () => {
    withPicker();
    renderPanes({ initialConversation: null });
    await screen.findByText('Researcher');
    act(() => {
      useAgentWorkspaceStore.getState().bindPane(WS, 'n1', { kind: 'page', id: 'page-1' });
    });
    expect(nodeById('n1')).toMatchObject({ target: { kind: 'page', id: 'page-1' } });
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('AgentPanes — the pane bar', () => {
  /** Every interactive switch needs THIS workspace's entry in the switch-decision data first. */
  async function findEnabledSelector(name: RegExp) {
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).not.toBeDisabled());
    return button;
  }

  it("shows the pane's own agent as its identity", async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    renderPanes();
    expect(await screen.findByText('Researcher')).toBeDefined();
  });

  it('switching to an agent the workspace already has a thread with shows THAT thread, without minting', async () => {
    // `conv-2` is a MEMBER, which under the node model means it has a node —
    // membership is the node, so a thread in the workspace with no node is a
    // state the model cannot hold (and the listing this used to read derived
    // its rows from those same nodes, so it could not hold it either).
    mockDel.mockResolvedValue({});
    seat(
      [rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')],
      [CONV_1_TARGET, { id: 'conv-2', kind: 'chat', title: 'Second', lastMessageAt: null, agentPageId: 'agent-2' }],
    );
    const user = userEvent.setup();
    // conv-2's pane renders as the HOST's own identity — a plain label, no
    // second agent selector — so the only "Writer" control on screen is the
    // menu item this test means to click.
    renderPanes({ hostConversationId: 'conv-2' });

    await screen.findAllByTestId('pane-chat');
    // Opened by KEYBOARD, not pointer: in a split grid the resize handle's
    // document-level pointer handling swallows Radix's open sequence under
    // jsdom, and this suite's other selector tests only ever run single-pane.
    // Enter on the focused trigger is the same open, through a path the
    // harness does not interfere with.
    (await findEnabledSelector(/Researcher/)).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: /Writer/ }));

    await waitFor(() => expect(nodeShowingChat('conv-2')).toBeDefined());
    expect(mockPost).not.toHaveBeenCalled();
    // And the outgoing thread's listing is closed — the fix for panes silently
    // accumulating stray sidebar rows.
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/agent-workspaces/ses-1/conversations/conv-1'));
  });

  /**
   * THE AWAIT WINDOW. The MRU re-read made this handler suspend, and nothing
   * invalidated an earlier invocation across it — so a pick the user had already
   * replaced could resume and act on a decision computed two selections ago,
   * taking the outgoing thread's DELETE with it.
   */
  it('a superseding pick on the same pane cancels the one waiting on the MRU re-read', async () => {
    // agent-1 ("Researcher") has TWO threads here, so switching to it takes the
    // re-read branch and suspends. agent-2 ("Writer") has none, so the second
    // pick decides straight away and mints.
    const nodeReads: Array<(value: unknown) => void> = [];
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/nodes')) return new Promise((resolve) => nodeReads.push(resolve));
      return jsonOk(defaultFetchRoute(url));
    });
    mockPost.mockResolvedValue({});
    mockDel.mockResolvedValue({});
    seat(
      [rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2'), chatNode('n3', WS, 2, 'conv-3')],
      [
        { id: 'conv-1', kind: 'chat', title: 'Assistant thread', lastMessageAt: null, agentPageId: null },
        { id: 'conv-2', kind: 'chat', title: 'A', lastMessageAt: '2026-08-01T00:00:00.000Z', agentPageId: 'agent-1' },
        { id: 'conv-3', kind: 'chat', title: 'B', lastMessageAt: '2026-08-02T00:00:00.000Z', agentPageId: 'agent-1' },
      ],
    );
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });
    await screen.findAllByTestId('pane-chat');

    const pick = async (agent: RegExp) => {
      const trigger = await screen.findByRole('button', { name: /Assistant/ });
      await waitFor(() => expect(trigger).not.toBeDisabled());
      trigger.focus();
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('menuitem', { name: agent }));
    };

    await pick(/Researcher/); // suspends on the re-read
    await pick(/Writer/); // supersedes it, and mints
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    // NOW let the first pick's re-read come back, so its handler resumes.
    await act(async () => {
      for (const resolve of nodeReads) resolve(jsonOk({ rev: 1, nodes: nodesNow(), targets: [] }));
      await Promise.resolve();
    });

    // Resuming, the stale pick would call `openConversation` for agent-1's
    // most-recent thread — which is already on the grid, so it takes the FOCUS
    // to that pane, off the conversation the second pick just made for the user.
    const minted = nodeShowingChat('new-id-1');
    expect(minted).toBeDefined();
    expect(useAgentWorkspaceStore.getState().workspaces[WS].activeNodeId).toBe(minted!.id);
  });

  /**
   * THE SUPERSEDER THAT DOES NOT MINT. The guard above only sees a newer pick if
   * that pick TOOK the pane's token, and until this was fixed only the mint
   * branch did — so a newer switch that landed an EXISTING thread was invisible
   * to it. The earlier, still-suspended switch would then resume against an
   * unchanged token and act on top of it: a second DELETE for the outgoing
   * thread, and the console selection dragged back to the agent the user had
   * already replaced.
   */
  it('a superseding pick that lands an EXISTING thread also cancels the suspended one', async () => {
    const seatedNodes = [
      rootNode,
      chatNode('n1', WS, 0, 'conv-1'),
      chatNode('n2', WS, 1, 'conv-2'),
      chatNode('n3', WS, 2, 'conv-3'),
      chatNode('n4', WS, 3, 'conv-4'),
    ];
    const seatedTargets: WorkspaceNodeTarget[] = [
      { id: 'conv-1', kind: 'chat', title: 'Assistant thread', lastMessageAt: null, agentPageId: null },
      // Researcher has TWO, so switching to it suspends on the MRU re-read.
      { id: 'conv-2', kind: 'chat', title: 'A', lastMessageAt: '2026-08-01T00:00:00.000Z', agentPageId: 'agent-1' },
      { id: 'conv-3', kind: 'chat', title: 'B', lastMessageAt: '2026-08-02T00:00:00.000Z', agentPageId: 'agent-1' },
      // Writer has ONE, so switching to it decides straight away — and lands an
      // existing thread rather than minting.
      { id: 'conv-4', kind: 'chat', title: 'C', lastMessageAt: '2026-08-03T00:00:00.000Z', agentPageId: 'agent-2' },
    ];
    let suspend = false;
    const nodeReads: Array<(value: unknown) => void> = [];
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/nodes')) {
        if (suspend) return new Promise((resolve) => nodeReads.push(resolve));
        return jsonOk({ rev: 1, nodes: seatedNodes, targets: seatedTargets });
      }
      return jsonOk(defaultFetchRoute(url));
    });
    mockDel.mockResolvedValue({});
    seat(seatedNodes, seatedTargets);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });
    await screen.findAllByTestId('pane-chat');

    const pick = async (agent: RegExp) => {
      const trigger = await findEnabledSelector(/Assistant/);
      trigger.focus();
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('menuitem', { name: agent }));
    };

    suspend = true;
    await pick(/Researcher/); // suspends on the re-read
    await pick(/Writer/); // decides at once, and lands conv-4 here
    await waitFor(() => expect(conversationDeletes()).toContain('/api/agent-workspaces/ses-1/conversations/conv-1'));

    // NOW let the suspended pick's re-read come back.
    await act(async () => {
      for (const resolve of nodeReads) resolve(jsonOk({ rev: 1, nodes: seatedNodes, targets: seatedTargets }));
      await Promise.resolve();
    });

    // It must not decide again on top of the pick that replaced it. The outgoing
    // thread is closed ONCE, by the switch that actually owns the pane.
    expect(
      conversationDeletes().filter((url) => url === '/api/agent-workspaces/ses-1/conversations/conv-1'),
    ).toHaveLength(1);
  });

  /**
   * A FAILED RE-READ IS NOT A REASON TO REFUSE THE SWITCH — the stale ordering
   * is still a real answer, and it is the one already on screen.
   *
   * The claim worth pinning is that the failure never reaches the caller:
   * `refreshWorkspaceSnapshot` wraps its whole body and reports failure as
   * `false`, so this handler resumes normally, keeps the candidates it had, and
   * runs the token check — rather than rejecting out of a `void`-ed call and
   * leaving the user's pick to do nothing at all.
   */
  it('switches on the stale ordering when the MRU re-read fails', async () => {
    const seatedNodes = [
      rootNode,
      chatNode('n1', WS, 0, 'conv-1'),
      chatNode('n2', WS, 1, 'conv-2'),
      chatNode('n3', WS, 2, 'conv-3'),
    ];
    const seatedTargets: WorkspaceNodeTarget[] = [
      { id: 'conv-1', kind: 'chat', title: 'Assistant thread', lastMessageAt: null, agentPageId: null },
      { id: 'conv-2', kind: 'chat', title: 'A', lastMessageAt: '2026-08-01T00:00:00.000Z', agentPageId: 'agent-1' },
      { id: 'conv-3', kind: 'chat', title: 'B', lastMessageAt: '2026-08-02T00:00:00.000Z', agentPageId: 'agent-1' },
    ];
    // Healthy until the pick, so the grid mounts on a real snapshot; the re-read
    // the switch itself makes is the one that fails.
    let failNodeReads = false;
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/nodes')) {
        if (failNodeReads) throw new Error('offline');
        return jsonOk({ rev: 1, nodes: seatedNodes, targets: seatedTargets });
      }
      return jsonOk(defaultFetchRoute(url));
    });
    mockDel.mockResolvedValue({});
    seat(seatedNodes, seatedTargets);
    const user = userEvent.setup();
    renderPanes({ initialConversation: null });
    await screen.findAllByTestId('pane-chat');

    failNodeReads = true;
    // Researcher has TWO threads here, so this takes the re-read branch.
    const trigger = await findEnabledSelector(/Assistant/);
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));

    // It still decides, on the ordering it already had: conv-3 is the most
    // recently active of Researcher's two, so the focus lands on its pane.
    // IT STILL DECIDED, on the ordering it already had. Both halves matter:
    // reaching the outgoing thread's DELETE means the handler resumed past the
    // failed re-read and ran its token check rather than rejecting out of a
    // `void`-ed call; and never POSTing means it found Researcher's thread in
    // the stale candidate list instead of concluding there was none and minting
    // a duplicate.
    await waitFor(() =>
      expect(conversationDeletes()).toContain('/api/agent-workspaces/ses-1/conversations/conv-1'),
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  /**
   * THE SAME WINDOW, FROM THE OTHER SIDE. Guarding the await above needs a token
   * saying who owns this pane — but TAKING one to find out is itself a write,
   * and this handler can still decide it has nothing to do: re-picking the agent
   * a pane already shows is `noop`. A token claimed on that path invalidates a
   * mint in flight for the same pane, and that mint answers supersession by
   * DELETING the conversation it just created — the pane appearing and then
   * silently vanishing, which is the defect this branch exists to fix, arriving
   * through a narrower door. So the guard PEEKS across the await, leaving the
   * claim to the mint that actually rebinds the pane.
   */
  it('re-picking the agent a pane already shows does not cancel a mint in flight for it', async () => {
    let resolveMint!: (value: unknown) => void;
    mockPost.mockReturnValue(new Promise((resolve) => (resolveMint = resolve)));
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');

    // Switch to Writer, who has no thread here: a mint, held in flight. The pane
    // is BOUND, so it goes on showing conv-1 — and its selector goes on saying
    // "Researcher" — for the whole round trip.
    await user.click(await findEnabledSelector(/Researcher/));
    await user.click(await screen.findByRole('menuitem', { name: /Writer/ }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    // Now re-pick the agent already on screen. `selectPaneAgent` answers `noop`:
    // nothing about this pane changes, so nothing may be invalidated either.
    await user.click(await findEnabledSelector(/Researcher/));
    await user.click(await screen.findByRole('menuitem', { name: /Researcher/ }));

    await act(async () => {
      resolveMint({});
      await Promise.resolve();
    });

    // The mint lands, and nothing tore it down on the way.
    await waitFor(() => expect(nodeShowingChat('new-id-1')).toBeDefined());
    expect(conversationDeletes()).not.toContain('/api/agent-workspaces/ses-1/conversations/new-id-1');
  });

  it('switching to an agent with no thread here mints one', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    mockPost.mockResolvedValue({});
    mockDel.mockResolvedValue({});
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(await findEnabledSelector(/Researcher/));
    await user.click(await screen.findByText('Writer'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/ai/page-agents/agent-2/conversations', {
        conversationId: 'new-id-1',
        sessionId: 'ses-1',
        activeNodeId: 'n1',
      }),
    );
  });

  /**
   * A REPLACEMENT PARKS THE OUTGOING NODE. It used to be re-pointed in place,
   * which made "this rectangle" and "this conversation" the same object; here
   * the old node keeps its binding and stays a member until its listing closes.
   */
  it('DESTROYS the outgoing node rather than re-pointing it', async () => {
    // Exercised through the MINT branch, which is where the replacement is
    // PLACED into this node's slot. (The focus-existing branch reaches the same
    // end by a different road — the outgoing thread's DELETE expels its node
    // server-side — which the test above pins.)
    mockPost.mockResolvedValue({});
    mockDel.mockResolvedValue({});
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(await findEnabledSelector(/Researcher/));
    await user.click(await screen.findByText('Writer'));

    // A binding is for life, so the switch does not re-point this node — it
    // takes the node away and puts a new one in its slot. The node used to
    // survive parked, keeping its binding; there is nowhere for it to survive.
    await waitFor(() => expect(nodeById('n1')).toBeUndefined());
    expect(panesNow().some((node) => node.target?.kind === 'chat' && node.target.id === 'new-id-1')).toBe(true);
  });

  it("is disabled while a thread's facts are still being fetched — the switch can't decide against a partial list", async () => {
    // Exactly what a structural `session:<id>` broadcast produces: another
    // member placed `conv-2`, so it is a MEMBER immediately, but the broadcast
    // carries no per-viewer facts and its agent is unknown here. Deciding
    // against the resolved subset alone would read "no thread for this agent"
    // and mint a duplicate. The re-read is held open, so this is the window
    // where the answer is genuinely still coming.
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/nodes')) return new Promise<never>(() => {});
      return jsonOk(defaultFetchRoute(url));
    });
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')], [CONV_1_TARGET]);
    renderPanes();
    expect(await screen.findByRole('button', { name: /Researcher/ })).toBeDisabled();
  });

  /**
   * AND IT COMES BACK. A missing target entry means "gone, or not readable by
   * this viewer" exactly as often as "not fetched yet" — the two are
   * deliberately indistinguishable — so a thread that was simply DELETED would
   * otherwise leave the switcher and New Conversation dead for the rest of the
   * session, however many times we asked. Once the re-read has been answered,
   * whatever is still missing is missing for good.
   */
  it('arms once the re-read has been answered, even if the facts never arrived', async () => {
    // The default route answers the nodes GET with a non-snapshot body, so the
    // probe settles WITHOUT resolving conv-2 — a permanently absent target.
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-2')], [CONV_1_TARGET]);
    renderPanes();
    await waitFor(async () =>
      expect(await screen.findByRole('button', { name: /Researcher/ })).not.toBeDisabled(),
    );
  });

  it('is enabled once every thread in the workspace has its facts', async () => {
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    renderPanes();
    expect(await screen.findByRole('button', { name: /Researcher/ })).not.toBeDisabled();
  });

  /**
   * THE SHARED-WORKSPACE CASE, which is why the grid stopped reading
   * `GET /api/agent-workspaces` at all: every filter on that listing carries
   * `ownerId`, so a workspace owned by another drive member is never in it. The
   * grid reached this workspace through drive MEMBERSHIP, and the tree answers
   * through that same gate — so the controls come alive on a workspace the
   * listing will never mention.
   */
  it("enables the switch for a workspace the ownership listing never returns — a colleague's workspace", async () => {
    mockFetchWithAuth.mockImplementation(async (url: string) => {
      // The listing answers as it does for a workspace you do not own: no row,
      // ever, however long you wait.
      if (url !== SESSION_RECORD_URL && url.includes('/api/agent-workspaces') && !url.endsWith('/nodes')) {
        return jsonOk({ sessions: [] });
      }
      return jsonOk(defaultFetchRoute(url));
    });
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    renderPanes();

    expect(await screen.findByRole('button', { name: /Researcher/ })).not.toBeDisabled();
  });

  it('has History and Settings tabs that switch the pane body', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    expect(await screen.findByTestId('pane-history-tab')).toBeDefined();

    await user.click(await screen.findByRole('tab', { name: /settings/i }));
    expect(await screen.findByTestId('pane-settings-tab')).toBeDefined();
  });

  it('hides the Settings tab for the Assistant, which has no agent page', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: null }]);
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')], [{ ...CONV_1_TARGET, agentPageId: null }]);
    renderPanes();

    await screen.findByTestId('pane-chat');
    expect(await screen.findByRole('tab', { name: /history/i })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /settings/i })).toBeNull();
  });
});

describe('AgentPanes — a History delete', () => {
  /**
   * A binding is for life, so a pane showing a deleted transcript cannot be
   * emptied in place: the node is destroyed and a fresh unbound one takes its
   * slot. The user keeps a pane where they had one, showing the picker.
   */
  /** The agent's own History list — a separate read from the workspace listing. */
  function mockAgentHistory() {
    const base = mockFetchWithAuth.getMockImplementation()!;
    mockFetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/ai/page-agents/agent-1/conversations' && init?.method !== 'DELETE') {
        return jsonOk({
          conversations: [
            {
              id: 'conv-1',
              title: 'First chat',
              preview: '',
              createdAt: new Date('2026-01-01').toISOString(),
              updatedAt: new Date('2026-01-01').toISOString(),
              messageCount: 1,
              sessionId: 'ses-1',
              isOwner: true,
              lastMessage: { role: 'user', timestamp: new Date('2026-01-01').toISOString() },
            },
          ],
        });
      }
      return base(url, init);
    });
  }

  it('replaces every node showing the deleted thread with a fresh unbound pane', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    mockAgentHistory();
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1'), chatNode('n2', WS, 1, 'conv-9')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findAllByTestId('pane-chat');
    await user.click(screen.getAllByRole('tab', { name: /history/i })[0]);
    await user.click(await screen.findByText('delete-conv-1'));

    await waitFor(() => expect(nodeShowingChat('conv-1')).toBeUndefined());
    // Same pane count — the rectangle survived, its binding did not.
    expect(panesNow().filter((node) => node.parentId !== null)).toHaveLength(2);
    expect(panesNow().some((node) => node.target === null)).toBe(true);
  });

  it('does NOT touch any pane when the delete is refused', async () => {
    mockSessionConversations([{ conversationId: 'conv-1', agentPageId: 'agent-1' }]);
    mockFetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return { ok: false, status: 409, json: async () => ({}) };
      if (url.includes('/api/agent-workspaces')) {
        return jsonOk({
          sessions: [
            {
              workspaceId: 'ses-1',
              sessionId: 'ses-1',
              conversations: [{ conversationId: 'conv-1', agentPageId: 'agent-1', lastMessageAt: null }],
            },
          ],
        });
      }
      return jsonOk(defaultFetchRoute(url));
    });
    mockAgentHistory();
    seat([rootNode, chatNode('n1', WS, 0, 'conv-1')]);
    const user = userEvent.setup();
    renderPanes();

    await screen.findByTestId('pane-chat');
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    await user.click(await screen.findByText('delete-conv-1'));

    await waitFor(() => expect(nodeById('n1')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } }));
  });
});

describe('AgentPanes — keyboard activation', () => {
  it('focusing a control inside a pane activates it, not only a click', async () => {
    seat([rootNode, paneNode('n1', WS, 0, null), chatNode('n2', WS, 1, 'conv-1')]);
    renderPanes();

    await screen.findByTestId('pane-chat');
    act(() => {
      useAgentWorkspaceStore.getState().selectNode(WS, 'n2');
    });
    expect(useAgentWorkspaceStore.getState().workspaces[WS]?.activeNodeId).toBe('n2');

    // Two 'Researcher' texts exist (the picker's button and the other pane's
    // bar identity) — scope to the picker's own.
    const pickerBody = screen.getAllByText('Researcher')[0];
    act(() => {
      pickerBody.focus();
      pickerBody.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await waitFor(() => expect(useAgentWorkspaceStore.getState().workspaces[WS]?.activeNodeId).toBe('n1'));
  });
});
