import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { Socket } from 'socket.io-client';
import { MACHINE_NODE_SCOPE } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import type { OpenTerminalScope, WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';

const mockUseMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => mockUseMobile() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// `useSyncedWorkspaceActions` (#2048) pushes layout changes to the server via
// these — fire-and-forget from the component's point of view, but each must
// resolve rather than return undefined, or the wrapper's `.catch()` throws.
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
}));

// jsdom has neither the pointer-capture APIs nor scrollIntoView Radix's Select
// uses when opening — without these stubs, clicking the agent-type trigger
// throws instead of rendering its options.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

// The pane's terminal is an xterm/socket subtree — stub it so what's under test
// is the LAYOUT the workspace picks, not the stream inside it.
vi.mock('../XtermTerminal', () => ({
  default: ({ sessionId, initialInput }: { sessionId: string; initialInput?: string }) => (
    <div data-testid="xterm" data-initial-input={initialInput}>
      {sessionId}
    </div>
  ),
}));

// The chat pane is a whole AI-chat subtree (Phase 11) — stubbed for the same
// reason as XtermTerminal: under test is WHICH surface the pane renders and
// what it is handed, not the chat UI inside it. The stub renders a close
// control from the threaded paneControls because that IS the contract under
// test: a chat pane's split/close live in ITS bar (one bar per pane), so
// TerminalPane must hand them down rather than draw its own.
vi.mock('./MachinePaneChat', () => ({
  default: ({
    machineId,
    terminalId,
    pendingPrompt,
    isActive,
    paneControls,
  }: {
    machineId: string;
    terminalId: string;
    pendingPrompt?: string;
    isActive?: boolean;
    paneControls?: { canSplit: boolean; canClose: boolean; onSplitRight(): void; onSplitDown(): void; onClose(): void };
  }) => (
    <div
      data-testid="machine-pane-chat"
      data-machine-id={machineId}
      data-terminal-id={terminalId}
      data-initial-input={pendingPrompt}
      data-pane-active={isActive ? 'true' : undefined}
    >
      {paneControls?.canClose && (
        <button type="button" title="Close pane" onClick={() => paneControls.onClose()}>
          Close pane
        </button>
      )}
    </div>
  ),
}));

const selectPane = vi.fn();
const splitRight = vi.fn();
const splitDown = vi.fn();
const closePane = vi.fn();
const createWorkspace = vi.fn(() => 'ws-new');
const bindPaneTerminal = vi.fn<
  (machineId: string, workspaceId: string, paneId: string, scope: OpenTerminalScope, prompt?: string) => boolean
>(() => true);
const clearPanePrompt = vi.fn();
const dismissPicker = vi.fn();

/** The spawn the picker performs — the only reason TerminalPanes touches the API. */
const addAgentTerminal = vi.fn(async (name: string, agentType: string) => ({ name, agentType, resumed: false }));
const removeAgentTerminal = vi.fn<(name: string) => Promise<void>>(async () => {});
/** The close-kill path — addressed by the session address re-derived from the
 * closing pane's OWN workspace, which need not be the active one. */
const killAgentTerminal = vi.fn<
  (machineId: string, scope: { projectName?: string; branchName?: string; name: string }) => Promise<void>
>(async () => {});
/** Records the scope the hook was asked for, so a spawn at the wrong checkout can't pass. */
const useAgentTerminalsArgs = vi.fn<(machineId: string, projectName: string | null, branchName: string | null) => void>();
/** The workspace-scoped SWR session list — what a kind-less pane's surface is
 * resolved against, and where a chat pane finds its conversation row id. */
let agentTerminalRows: { id: string; name: string; agentType: string; createdAt: string }[] = [];
let agentTerminalsLoading = false;
vi.mock('@/hooks/useAgentTerminals', () => ({
  killAgentTerminal: (machineId: string, scope: { projectName?: string; branchName?: string; name: string }) =>
    killAgentTerminal(machineId, scope),
  useAgentTerminals: (machineId: string, projectName: string | null, branchName: string | null) => {
    useAgentTerminalsArgs(machineId, projectName, branchName);
    return {
      agentTerminals: agentTerminalRows,
      isLoading: agentTerminalsLoading,
      error: undefined,
      mutate: vi.fn(),
      addAgentTerminal,
      removeAgentTerminal,
    };
  },
}));

const WORKSPACE_ID = 'ws-1';
/** The checkout this workspace's agents run in. */
const WORKSPACE_SCOPE = { level: 'branch', projectName: 'app', branchName: 'main' } as const;
/** The same checkout as it crosses the wire — what a spawn/kill is addressed by. */
const WORKSPACE_NAMES = { projectName: 'app', branchName: 'main' };

const aWorkspace = (grid: Pick<WorkspaceState, 'columns' | 'activePaneId' | 'pendingPickerPaneId'>): WorkspaceState => ({
  id: WORKSPACE_ID,
  name: 'Workspace 1',
  scope: WORKSPACE_SCOPE,
  ...grid,
});

/** Two panes side by side in two columns — a layout only a wide screen can make. */
const SPLIT_WORKSPACE = aWorkspace({
  columns: [
    { id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'left' } }] },
    { id: 'col-2', panes: [{ id: 'pane-2', scope: { name: 'right' } }] },
  ],
  activePaneId: 'pane-2',
  pendingPickerPaneId: null,
});

/** One pane, nothing to split into and nothing to close — the phone default. */
const SOLO_WORKSPACE = aWorkspace({
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'solo' } }] }],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
});

/** An empty pane: no terminal in it, so it offers the inline agent picker. */
const EMPTY_WORKSPACE = aWorkspace({
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
});

/** The same empty pane, freshly made by a split — its picker should take focus. */
const JUST_SPLIT_WORKSPACE = aWorkspace({
  ...EMPTY_WORKSPACE,
  pendingPickerPaneId: 'pane-1',
});

/** Two panes showing the SAME session — `openTerminal`'s doc records that this
 * is legal, and it is what stops close-to-kill from being a plain `X`. */
const SHARED_SESSION_WORKSPACE = aWorkspace({
  columns: [
    { id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'shared' } }] },
    { id: 'col-2', panes: [{ id: 'pane-2', scope: { name: 'shared' } }] },
  ],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
});

/** The workspace the middle view is showing — `null` means the machine has an
 * entry but zero workspaces, which is a legal state, not a broken one. */
let workspace: WorkspaceState | null = SPLIT_WORKSPACE;
/** False = no machine entry at all: the frame before `ensureMachine` commits. */
let machineEnsured = true;
/** Additional NON-active workspaces on the machine, listed BEFORE the active
 * one in the machine's order — the shape that trips up any machine-wide pane
 * lookup that assumes pane ids are globally unique. */
let extraWorkspaces: WorkspaceState[] = [];
beforeEach(() => {
  extraWorkspaces = [];
  agentTerminalRows = [];
  agentTerminalsLoading = false;
});

// Only the store HOOK is faked; selectActiveWorkspace / panesOf / autoSessionName
// stay real, so these tests exercise the same active-workspace lookup the app does
// rather than a lookalike of it.
vi.mock('@/stores/machine-workspace/useMachineWorkspaceStore', async () => {
  const actual = await vi.importActual<typeof import('@/stores/machine-workspace/useMachineWorkspaceStore')>(
    '@/stores/machine-workspace/useMachineWorkspaceStore',
  );
  const fakeState = () => ({
    machines: !machineEnsured
      ? {}
      : {
          m1: workspace
            ? {
                workspaces: Object.fromEntries([
                  ...extraWorkspaces.map((extra) => [extra.id, extra] as const),
                  [WORKSPACE_ID, workspace] as const,
                ]),
                order: [...extraWorkspaces.map((extra) => extra.id), WORKSPACE_ID],
                activeWorkspaceId: WORKSPACE_ID,
              }
            : { workspaces: {}, order: [], activeWorkspaceId: '' },
        },
    selectPane,
    splitRight,
    splitDown,
    closePane,
    createWorkspace,
    bindPaneTerminal,
    clearPanePrompt,
    dismissPicker,
  });
  const useMachineWorkspaceStoreMock = (selector: (state: Record<string, unknown>) => unknown) => selector(fakeState());
  // `useSyncedWorkspaceActions` (#2048) reads fresh state imperatively via
  // `.getState()`, outside the selector/render cycle — real zustand stores
  // expose this as a static method on the hook function itself.
  useMachineWorkspaceStoreMock.getState = fakeState;
  return {
    ...actual,
    useMachineWorkspaceStore: useMachineWorkspaceStoreMock,
  };
});

import TerminalPanes from './TerminalPanes';

// A pane only mounts its terminal once a socket exists; nothing in these tests
// touches the socket itself (XtermTerminal is stubbed above).
const socket = {} as Socket;

const onDesktop = () => mockUseMobile.mockReturnValue(false);
const onMobile = () => mockUseMobile.mockReturnValue(true);

describe('TerminalPanes (no terminals open)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDesktop();
    machineEnsured = true;
    workspace = SPLIT_WORKSPACE;
  });

  test('a machine with zero workspaces offers a New Terminal button', async () => {
    workspace = null;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'a machine whose views the user removed — a legal, converged state',
      should:
        'say so and offer a way back; without something to render here the app had to keep a workspace alive purely so the grid had something to draw, which is what made the last row unremovable',
      actual: {
        notice: screen.queryByTestId('machine-no-terminals') !== null,
        action: screen.queryByRole('button', { name: 'New Terminal' }) !== null,
        panes: screen.queryAllByTestId('xterm').length,
      },
      expected: { notice: true, action: true, panes: 0 },
    });
  });

  test('New Terminal creates a workspace at machine scope', async () => {
    workspace = null;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'New Terminal' }));

    assert({
      given: "the empty state's only action",
      should: 'create a machine-scoped workspace — the button has to actually open one',
      actual: createWorkspace.mock.calls[0],
      expected: ['m1', MACHINE_NODE_SCOPE],
    });
  });

  test('a machine with no entry yet renders nothing — not the empty state', async () => {
    machineEnsured = false;
    workspace = null;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the frame between first render and ensureMachine committing',
      should:
        'render nothing — flashing "No terminals open" for one frame on every machine open is a different (and wrong) claim about the world',
      actual: screen.queryByTestId('machine-no-terminals') !== null,
      expected: false,
    });
  });
});

describe('TerminalPanes (close means close)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDesktop();
    machineEnsured = true;
    workspace = SPLIT_WORKSPACE;
  });

  test('closing a pane kills the session it held — at the WORKSPACE\'s checkout, the pane\'s only checkout', async () => {
    // Inverted (Phase 1). The pane stores a name and nothing else, so its
    // session lives at ITS WORKSPACE's checkout — app/main here. The kill has
    // to carry that, re-derived at the call site: a DELETE for a bare name
    // would address the machine root, a different terminal (or nothing),
    // leaving the one the user closed running as an unclaimed session.
    workspace = SOLO_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('xterm');

    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: 'the close control on a pane holding a session',
      should:
        'kill the PTY at the (project, branch, name) re-derived from the workspace — detaching instead is what MANUFACTURES the unclaimed rows that cannot be removed from the sidebar',
      actual: {
        kills: killAgentTerminal.mock.calls,
        viaWorkspaceHook: removeAgentTerminal.mock.calls.length,
      },
      expected: {
        kills: [['m1', { ...WORKSPACE_NAMES, name: 'solo' }]],
        viaWorkspaceHook: 0,
      },
    });
  });

  test('a failed close-kill TELLS the user the agent is still running — the pane is already gone', async () => {
    // The pane closes optimistically, so a failed kill has no surface left to
    // report through except a toast: the agent is still running (and billing),
    // reachable only via the rolled-back sidebar row the user must go find.
    workspace = SOLO_WORKSPACE;
    killAgentTerminal.mockRejectedValueOnce(new Error('sprite unreachable'));
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('xterm');

    await userEvent.click(screen.getByTitle('Close pane'));

    const { toast } = await import('sonner');
    await waitFor(() => {
      assert({
        given: 'a close whose kill request failed after the pane was already removed',
        should: 'toast that the named agent is still running rather than fail silently',
        actual: vi.mocked(toast.error).mock.calls[0]?.[0],
        expected: 'Failed to stop solo — it is still running, listed in the sidebar',
      });
    });
  });

  test('closing a pane whose session another pane still shows does NOT kill it', async () => {
    workspace = SHARED_SESSION_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findAllByTestId('xterm');

    await userEvent.click(screen.getAllByTitle('Close pane')[0]);

    assert({
      given: 'one of two panes showing the SAME session',
      should:
        'close the pane but leave the PTY alone — the other pane is still showing it, and pulling it out from under them would kill a terminal they are looking at',
      actual: killAgentTerminal.mock.calls.length,
      expected: 0,
    });
  });

  // Inverted (Phase 1): a same-name session at another checkout can no longer
  // sit in a sibling PANE — a pane's checkout is its workspace's. It sits in
  // another WORKSPACE, and the "is this session shown elsewhere" test has to
  // re-derive each candidate pane's identity through ITS OWN workspace's scope.
  // Comparing bare names across workspaces would spare the kill and leave the
  // closed pane's PTY running (and billing) with no view left to reach it.
  test('a same-NAME session in another workspace\'s checkout is a different session, and does not block the kill', async () => {
    workspace = aWorkspace({
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'shell-x' } }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    });
    extraWorkspaces = [
      {
        id: 'ws-other-branch',
        name: 'Other branch',
        scope: { level: 'branch', projectName: 'app', branchName: 'other' },
        columns: [{ id: 'col-other', panes: [{ id: 'pane-other', scope: { name: 'shell-x' } }] }],
        activePaneId: 'pane-other',
        pendingPickerPaneId: null,
      },
    ];
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findAllByTestId('xterm');

    await userEvent.click(screen.getAllByTitle('Close pane')[0]);

    assert({
      given: 'two workspaces at different branches, each holding a pane named shell-x',
      should: 'still kill the closed one, at ITS workspace\'s checkout — comparing on name alone would silently skip it',
      actual: killAgentTerminal.mock.calls,
      expected: [['m1', { ...WORKSPACE_NAMES, name: 'shell-x' }]],
    });
  });

  // Regression (CodeRabbit): pane ids arrive from server layouts other clients
  // minted, so nothing guarantees they are globally unique — they are only
  // unique within their own grid. A machine-wide id lookup finds whichever
  // same-id pane comes FIRST in the machine's order and kills THAT pane's
  // session instead of the one the user closed.
  test('a same-ID pane in ANOTHER workspace is never mistaken for the closing pane', async () => {
    workspace = SOLO_WORKSPACE; // holds pane-1 → session "solo"
    extraWorkspaces = [
      {
        id: 'ws-foreign',
        name: 'Foreign',
        scope: WORKSPACE_SCOPE,
        columns: [
          { id: 'col-foreign', panes: [{ id: 'pane-1', scope: { name: 'foreign-session' } }] },
        ],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      },
    ];
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('xterm');

    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: "two workspaces each holding a pane with the SAME id, the foreign one first in the machine's order",
      should: "kill the session of the pane in THIS workspace — resolving the pane machine-wide would kill the foreign workspace's session and leave the closed one running",
      actual: killAgentTerminal.mock.calls,
      expected: [['m1', { ...WORKSPACE_NAMES, name: 'solo' }]],
    });
  });

  test('closing an EMPTY pane kills nothing', async () => {
    workspace = EMPTY_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: 'a pane holding the picker rather than a session',
      should: 'have no PTY to kill',
      actual: killAgentTerminal.mock.calls.length,
      expected: 0,
    });
  });
});

describe('TerminalPanes (narrow-viewport degradation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineEnsured = true;
    workspace = SPLIT_WORKSPACE;
  });

  test('a wide viewport renders every pane of the split, with the split controls', async () => {
    onDesktop();
    render(<TerminalPanes machineId="m1" socket={socket} />);

    const terminals = await screen.findAllByTestId('xterm');

    assert({
      given: 'a two-pane split on a wide viewport',
      should: 'render both panes and offer the split controls',
      actual: {
        panes: terminals.length,
        // One set of split controls per pane.
        splitControls: screen.queryAllByTitle('Split right').length,
      },
      expected: { panes: 2, splitControls: 2 },
    });
  });

  test('a narrow viewport shows only the ACTIVE pane, and hides the split controls', async () => {
    onMobile();
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await screen.findAllByTestId('xterm');
    const visible = screen.getAllByTestId('mobile-pane').filter((pane) => pane.dataset.hidden === undefined);

    assert({
      given: 'the same two-pane split on a phone-width viewport',
      should: 'show only the active pane — two terminals at ~180px each are unusable slivers — and offer no split',
      actual: {
        visiblePanes: visible.length,
        showsActive: visible[0]?.textContent?.includes('right'),
        canSplit: screen.queryByTitle('Split right') !== null,
      },
      expected: { visiblePanes: 1, showsActive: true, canSplit: false },
    });
  });

  test('the panes it hides stay MOUNTED — hiding a pane must not tear down its PTY', async () => {
    onMobile();
    render(<TerminalPanes machineId="m1" socket={socket} />);

    const terminals = await screen.findAllByTestId('xterm');
    const hiddenPanes = screen.getAllByTestId('mobile-pane').filter((pane) => pane.dataset.hidden === 'true');

    assert({
      given: 'a pane hidden by the narrow-viewport collapse',
      should:
        'keep its terminal mounted — unmounting emits agent-terminal:disconnect, which loses a finished agent\'s exit code and cold-starts a fresh PTY on return',
      actual: {
        mountedMachines: terminals.length,
        hidden: hiddenPanes.length,
      },
      expected: { mountedMachines: 2, hidden: 1 },
    });
  });

  test('a hidden pane is hidden by VISIBILITY, never by display', async () => {
    onMobile();
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findAllByTestId('xterm');

    const hidden = screen.getAllByTestId('mobile-pane').filter((pane) => pane.dataset.hidden === 'true');

    assert({
      given: 'a pane that mounts while inactive',
      should:
        'hide it with visibility:hidden — a display:none box measures 0, so xterm would read a zero-width character cell at open() and FitAddon would propose no dimensions, leaving the pane blank even after it is shown',
      actual: {
        invisible: hidden.every((pane) => pane.classList.contains('invisible')),
        displayNone: hidden.some((pane) => pane.classList.contains('hidden')),
      },
      expected: { invisible: true, displayNone: false },
    });
  });

  test('the narrow-viewport pane strip is the way back to the panes the collapse hid', async () => {
    onMobile();
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'left' }));

    assert({
      given: 'the hidden pane tapped in the pane strip',
      should: 'select it — without the strip, panes opened on a desktop would be silently unreachable on a phone',
      actual: selectPane.mock.calls[0],
      expected: ['m1', WORKSPACE_ID, 'pane-1'],
    });
  });

  test('a single-pane workspace renders no pane strip on a narrow viewport', async () => {
    onMobile();
    workspace = SOLO_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await screen.findByTestId('xterm');

    assert({
      given: 'a workspace with nothing hidden',
      should: 'render no pane strip — it exists only to reach panes the collapse hid',
      actual: screen.queryByRole('button', { name: 'solo' }) !== null,
      expected: false,
    });
  });

  test('a lone EMPTY pane on a phone can still be closed — that is how you remove the view', async () => {
    onMobile();
    workspace = EMPTY_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the only pane on a narrow viewport, empty, where a split is not offered',
      should:
        'still offer close — closing the last pane removes the workspace, so this is the gesture that discards a view the user does not want; it used to be suppressed because the workspace had nowhere to go',
      actual: {
        split: screen.queryByTitle('Split right') !== null,
        close: screen.queryByTitle('Close pane') !== null,
      },
      expected: { split: false, close: true },
    });
  });

  test('a lone pane HOLDING a terminal can still close it, even on a phone', async () => {
    onMobile();
    workspace = SOLO_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('xterm');

    assert({
      given: 'a workspace whose only pane shows a session — one that may no longer exist server-side',
      should:
        'offer close, which kills the session and takes the workspace with it; without it that workspace is stuck forever on a terminal that will never connect again',
      actual: {
        canClose: screen.queryByTitle('Close pane') !== null,
        canSplit: screen.queryByTitle('Split right') !== null,
      },
      expected: { canClose: true, canSplit: false },
    });
  });
});

describe('TerminalPanes (split-and-pick spawn)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDesktop();
    workspace = EMPTY_WORKSPACE;
  });

  test('an empty pane picks an agent and gets it running — ONE action, no modal, no name step, no prompt form', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    const [spawnedName, spawnedType] = addAgentTerminal.mock.calls[0] ?? [];
    assert({
      given: 'an empty pane and one click on Shell',
      should:
        'spawn the session — auto-named, never prompted for — at the ACTIVE NODE\'s scope and bind it to that pane with NO starting prompt (the prompt is typed in the pane), in one action',
      actual: {
        spawns: addAgentTerminal.mock.calls.length,
        agentType: spawnedType,
        autoNamed: spawnedName?.startsWith(`${spawnedType}-`),
        bind: bindPaneTerminal.mock.calls[0],
      },
      expected: {
        spawns: 1,
        agentType: 'shell',
        autoNamed: true,
        bind: [
          'm1',
          WORKSPACE_ID,
          'pane-1',
          { projectName: 'app', branchName: 'main', name: spawnedName },
          undefined,
        ],
      },
    });
  });

  test('the agent picker offers Agent then Shell — registry-driven, no retired types', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the empty pane\'s agent picker',
      should:
        'render one instant-spawn button per PICKABLE_AGENT_TYPES entry, in registry order — Agent (pagespace) first, then Shell; claude/codex/pagespace-cli are retired and must not resurface here',
      actual: {
        agent: screen.queryByRole('button', { name: 'Agent' }) !== null,
        shell: screen.queryByRole('button', { name: 'Shell' }) !== null,
        claude: screen.queryByRole('button', { name: 'claude' }),
        codex: screen.queryByRole('button', { name: 'codex' }),
      },
      expected: { agent: true, shell: true, claude: null, codex: null },
    });
  });

  test('a pane made by a split opens its picker FOCUSED on the Agent button', async () => {
    workspace = JUST_SPLIT_WORKSPACE;

    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the empty pane a split just created',
      should: 'focus its first spawn choice (and consume the pending-picker flag) rather than leave the user facing a blank pane',
      actual: {
        focused: document.activeElement === screen.getByRole('button', { name: 'Agent' }),
        consumed: dismissPicker.mock.calls[0],
      },
      expected: { focused: true, consumed: ['m1', WORKSPACE_ID, 'pane-1'] },
    });
  });

  test('an empty pane that was NOT just split does not steal focus', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'an empty pane the user did not just create (a restored grid, say)',
      should: 'leave focus alone — auto-focus is the split\'s intent, not every empty pane\'s',
      actual: document.activeElement === screen.getByRole('button', { name: 'Agent' }),
      expected: false,
    });
  });

  test('a failed spawn leaves the pane empty and its picker usable', async () => {
    addAgentTerminal.mockRejectedValueOnce(new Error('name_in_use'));
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    assert({
      given: 'a spawn the API rejected',
      should: 'bind nothing and re-offer the picker — a pane bound to a session that does not exist would connect to nothing',
      actual: {
        bound: bindPaneTerminal.mock.calls.length,
        canRetry: !screen.getByRole('button', { name: 'Shell' }).hasAttribute('disabled'),
      },
      expected: { bound: 0, canRetry: true },
    });
  });

  test('the spawn is scoped to the WORKSPACE\'s checkout, not the machine root', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    assert({
      given: 'a workspace whose scope is the branch app/main',
      should:
        'ask the agent-terminals API for THAT scope — a spawn that ignored it would boot the agent in the machine root instead of the branch checkout, and the picker\'s promise ("Runs in app / main") would be a lie',
      actual: {
        hookScope: useAgentTerminalsArgs.mock.calls.at(-1),
        boundScope: bindPaneTerminal.mock.calls[0]?.[3],
        promise: screen.getByText(/Runs in/).textContent,
      },
      expected: {
        hookScope: ['m1', 'app', 'main'],
        boundScope: { projectName: 'app', branchName: 'main', name: bindPaneTerminal.mock.calls[0]?.[3]?.name },
        promise: 'Runs in app / main.',
      },
    });
  });

  test('a spawn that lands nowhere takes its session back out', async () => {
    // The pane was closed (or the page left) while the Sprite was booting.
    bindPaneTerminal.mockReturnValueOnce(false);
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    assert({
      given: 'a spawn whose pane is gone by the time it resolves',
      should:
        'remove the session it created — the row exists server-side but belongs to no pane, so leaving it would strand a terminal the user never asked for and never saw appear',
      actual: removeAgentTerminal.mock.calls[0]?.[0] === addAgentTerminal.mock.calls[0]?.[0],
      expected: true,
    });
  });

  test('a pane carrying a starting prompt hands it to its terminal', async () => {
    // The pane the picker just spawned into: bound, with its prompt not yet typed.
    workspace = aWorkspace({
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'shell-a1' }, pendingPrompt: 'fix the build' }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    });

    render(<TerminalPanes machineId="m1" socket={socket} />);
    const terminal = await screen.findByTestId('xterm');

    assert({
      given: "a pane holding the starting prompt from the picker",
      should:
        'pass it to the terminal, which is what types it into the PTY — without this wiring the prompt is stored, never delivered, and no test would notice',
      actual: terminal.getAttribute('data-initial-input'),
      expected: 'fix the build',
    });
  });

  test('a session the API says ALREADY EXISTED still binds with no prompt', async () => {
    // `spawnAgentTerminal` is an upsert: `resumed` means it gave back a session that
    // was already there (and whose agent may have been running for hours), rather
    // than creating one. Instant spawn never carries a prompt anyway, but this
    // pins that a resumed bind stays promptless even if a prompt source returns.
    addAgentTerminal.mockResolvedValueOnce({ name: 'shell-a1', agentType: 'shell', resumed: true });

    render(<TerminalPanes machineId="m1" socket={socket} />);
    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    assert({
      given: 'a spawn the API served by handing back an EXISTING session',
      should: 'bind it to the pane but carry NO prompt — an already-running agent must never be typed at',
      actual: { bound: bindPaneTerminal.mock.calls.length, prompt: bindPaneTerminal.mock.calls[0]?.[4] },
      expected: { bound: 1, prompt: undefined },
    });
  });

  test('a spawn that lands nowhere does NOT kill a terminal it found rather than created', async () => {
    // The two hazards meet: the API handed back a session that ALREADY EXISTED, and
    // the pane went away before it could be bound. `removeAgentTerminal` KILLS the
    // terminal — so cleaning up here destroys an agent that may be mid-task in
    // someone else's pane. Only a session this spawn actually brought into the world
    // is ours to take back out.
    addAgentTerminal.mockResolvedValueOnce({ name: 'shell-a1', agentType: 'shell', resumed: true });
    bindPaneTerminal.mockReturnValueOnce(false);

    render(<TerminalPanes machineId="m1" socket={socket} />);
    await userEvent.click(screen.getByRole('button', { name: 'Shell' }));

    assert({
      given: 'an unbindable spawn the API served from an EXISTING session',
      should: 'leave that session alone — the cleanup path kills terminals, and this spawn did not create this one',
      actual: removeAgentTerminal.mock.calls.length,
      expected: 0,
    });
  });
});

describe('TerminalPanes (PageSpace Agent panes)', () => {
  /** A pane bound to the chat agent — kind on the SCOPE (Phase 9), so the
   * surface decision survives every place a scope flows opaquely. */
  const CHAT_SCOPE = { name: 'pagespace-a1', kind: 'chat' as const };
  /** The chat session's own row — its id IS the conversation id (Phase 4). */
  const CHAT_ROW = { id: 'row-ps1', name: 'pagespace-a1', agentType: 'pagespace', createdAt: '' };

  const soloPane = (pane: { scope: OpenTerminalScope | null; pendingPrompt?: string }) =>
    aWorkspace({
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', ...pane }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    onDesktop();
    machineEnsured = true;
    workspace = EMPTY_WORKSPACE;
  });

  test('picking Agent spawns a pagespace session bound with a chat-kind scope', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));

    const [spawnedName, spawnedType] = addAgentTerminal.mock.calls[0] ?? [];
    assert({
      given: 'the picker\'s "Agent" choice, spawned',
      should:
        'create a pagespace session and bind it with kind "chat" on the scope — without the kind, the pane would have to guess its surface from the SWR list on every future mount',
      actual: {
        agentType: spawnedType,
        boundScope: bindPaneTerminal.mock.calls[0]?.[3],
      },
      expected: {
        agentType: 'pagespace',
        boundScope: { projectName: 'app', branchName: 'main', name: spawnedName, kind: 'chat' },
      },
    });
  });

  test('a RESUMED spawn takes its kind from the API\'s agentType, not the picked one', async () => {
    // The upsert handed back an EXISTING session that happens to wear a
    // pagespace-shaped name but is actually a PTY agent. Labeling it chat
    // from the PICKED type would mislabel it forever — an explicit kind
    // beats the SWR fallback on every future mount.
    addAgentTerminal.mockResolvedValueOnce({ name: 'pagespace-x', agentType: 'shell', resumed: true });
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));

    assert({
      given: 'an Agent pick the API served by resuming an existing shell session',
      should:
        'bind WITHOUT a chat kind — the surface is judged by the API\'s answer, the same standard the resumed-prompt guard applies',
      actual: bindPaneTerminal.mock.calls[0]?.[3],
      expected: { projectName: 'app', branchName: 'main', name: 'pagespace-x' },
    });
  });

  test('a chat pane whose row is GONE from the loaded list says so — not an eternal spinner', async () => {
    workspace = soloPane({ scope: CHAT_SCOPE });
    // The list has answered and the session isn't in it: killed elsewhere.
    agentTerminalRows = [];
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'a chat-kind pane whose session the loaded list no longer contains',
      should:
        'render a notice with close still reachable — an indefinite "Loading session…" over a dead session would read as a hang',
      actual: {
        notice: screen.queryByText('This session no longer exists') !== null,
        loading: screen.queryByText('Loading session…') !== null,
        chat: screen.queryByTestId('machine-pane-chat') !== null,
        xterm: screen.queryByTestId('xterm') !== null,
        canClose: screen.queryByTitle('Close pane') !== null,
      },
      expected: { notice: true, loading: false, chat: false, xterm: false, canClose: true },
    });
  });

  test('a chat-kind pane renders MachinePaneChat — addressed by row id, with the picker prompt — not xterm', async () => {
    workspace = soloPane({ scope: CHAT_SCOPE, pendingPrompt: 'audit the docs' });
    agentTerminalRows = [CHAT_ROW];
    render(<TerminalPanes machineId="m1" socket={socket} />);

    const chat = await screen.findByTestId('machine-pane-chat');

    assert({
      given: 'a pane whose scope carries kind "chat", its session row in the list',
      should:
        'render the chat surface addressed by the ROW id (the machine-anchored conversation) carrying the starting prompt — and never mount an xterm for it',
      actual: {
        terminalId: chat.getAttribute('data-terminal-id'),
        machineId: chat.getAttribute('data-machine-id'),
        pendingPrompt: chat.getAttribute('data-initial-input'),
        xterm: screen.queryByTestId('xterm') !== null,
      },
      expected: {
        terminalId: 'row-ps1',
        machineId: 'm1',
        pendingPrompt: 'audit the docs',
        xterm: false,
      },
    });
  });

  test('no kind hint + SWR resolving the name to pagespace renders chat', async () => {
    // A kind-less binding: made before the kind tag existed, or by a path that
    // didn't set it. The session list is the only witness to what it is.
    workspace = soloPane({ scope: { name: 'pagespace-a1' } });
    agentTerminalRows = [CHAT_ROW];
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'a kind-less pane whose name the loaded list maps to agentType "pagespace"',
      should: 'resolve to the chat surface',
      actual: {
        chat: screen.queryByTestId('machine-pane-chat') !== null,
        xterm: screen.queryByTestId('xterm') !== null,
      },
      expected: { chat: true, xterm: false },
    });
  });

  test('no kind hint + SWR resolving the name to shell renders xterm', async () => {
    workspace = soloPane({ scope: { name: 'shell-b2' } });
    agentTerminalRows = [{ id: 'row-c1', name: 'shell-b2', agentType: 'shell', createdAt: '' }];
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'a kind-less pane whose name the loaded list maps to agentType "shell"',
      should: 'resolve to the PTY surface',
      actual: {
        xterm: screen.queryByTestId('xterm') !== null,
        chat: screen.queryByTestId('machine-pane-chat') !== null,
      },
      expected: { xterm: true, chat: false },
    });
  });

  test('no kind hint while the list is loading renders PaneLoading — NEVER xterm for a maybe-chat session', async () => {
    workspace = soloPane({ scope: { name: 'pagespace-a1' } });
    agentTerminalsLoading = true;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'a kind-less pane before the session list has answered',
      should:
        'hold at a loading state — mounting Xterm now would cold-start a PTY (and register a viewer) for a session that may turn out to be a chat',
      actual: {
        loading: screen.queryByText('Loading session…') !== null,
        xterm: screen.queryByTestId('xterm') !== null,
        chat: screen.queryByTestId('machine-pane-chat') !== null,
      },
      expected: { loading: true, xterm: false, chat: false },
    });
  });

  test('on mobile, a hidden chat pane stays MOUNTED — invisible, never unmounted', async () => {
    onMobile();
    workspace = aWorkspace({
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: CHAT_SCOPE }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: { name: 'shell-b2', kind: 'terminal' } }] },
      ],
      activePaneId: 'pane-2',
      pendingPickerPaneId: null,
    });
    agentTerminalRows = [CHAT_ROW];
    render(<TerminalPanes machineId="m1" socket={socket} />);

    const chat = await screen.findByTestId('machine-pane-chat');
    const wrapper = screen
      .getAllByTestId('mobile-pane')
      .find((pane) => pane.contains(chat));

    assert({
      given: 'a chat pane hidden by the narrow-viewport collapse',
      should:
        'keep it mounted but invisible, exactly like a hidden PTY pane — unmounting would drop the chat\'s in-flight state, and its streaming reply with it',
      actual: {
        mounted: chat !== null,
        hidden: wrapper?.dataset.hidden,
        invisible: wrapper?.classList.contains('invisible'),
      },
      expected: { mounted: true, hidden: 'true', invisible: true },
    });
  });

  test('closing a chat pane kills its session row, exactly as a PTY close does', async () => {
    workspace = soloPane({ scope: CHAT_SCOPE });
    agentTerminalRows = [CHAT_ROW];
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('machine-pane-chat');

    await userEvent.click(screen.getByTitle('Close pane'));

    assert({
      given: 'the close control on a pane rendering the chat surface',
      should:
        'kill the session at the pane\'s own scope, same as any terminal — the row delete is cheap (Phase 2) and the conversation survives it',
      actual: killAgentTerminal.mock.calls,
      expected: [['m1', { ...WORKSPACE_NAMES, ...CHAT_SCOPE }]],
    });
  });
});
