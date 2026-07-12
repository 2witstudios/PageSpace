import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { Socket } from 'socket.io-client';
import type { OpenTerminalScope, WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';

const mockUseMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/useMobile', () => ({ useMobile: () => mockUseMobile() }));

// The pane's terminal is an xterm/socket subtree — stub it so what's under test
// is the LAYOUT the workspace picks, not the stream inside it.
vi.mock('../XtermTerminal', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="xterm">{sessionId}</div>,
}));

const selectPane = vi.fn();
const splitRight = vi.fn();
const splitDown = vi.fn();
const closePane = vi.fn();
const bindPaneTerminal = vi.fn<
  (machineId: string, workspaceId: string, paneId: string, scope: OpenTerminalScope, prompt?: string) => boolean
>(() => true);
const clearPanePrompt = vi.fn();
const dismissPicker = vi.fn();

/** The spawn the picker performs — the only reason TerminalPanes touches the API. */
const addAgentTerminal = vi.fn(async (name: string, agentType: string) => ({ name, agentType, resumed: false }));
const removeAgentTerminal = vi.fn<(name: string) => Promise<void>>(async () => {});
/** Records the scope the hook was asked for, so a spawn at the wrong checkout can't pass. */
const useAgentTerminalsArgs = vi.fn<(machineId: string, projectName: string | null, branchName: string | null) => void>();
vi.mock('@/hooks/useAgentTerminals', () => ({
  useAgentTerminals: (machineId: string, projectName: string | null, branchName: string | null) => {
    useAgentTerminalsArgs(machineId, projectName, branchName);
    return {
      agentTerminals: [],
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      addAgentTerminal,
      removeAgentTerminal,
    };
  },
}));

const WORKSPACE_ID = 'ws-1';
/** The checkout this workspace's agents run in. */
const WORKSPACE_SCOPE = { projectName: 'app', branchName: 'main' };

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

/** The workspace the middle view is showing. */
let workspace: WorkspaceState = SPLIT_WORKSPACE;

// Only the store HOOK is faked; selectActiveWorkspace / panesOf / autoSessionName
// stay real, so these tests exercise the same active-workspace lookup the app does
// rather than a lookalike of it.
vi.mock('@/stores/machine-workspace/useMachineWorkspaceStore', async () => {
  const actual = await vi.importActual<typeof import('@/stores/machine-workspace/useMachineWorkspaceStore')>(
    '@/stores/machine-workspace/useMachineWorkspaceStore',
  );
  return {
    ...actual,
    useMachineWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        machines: {
          m1: { workspaces: { [WORKSPACE_ID]: workspace }, order: [WORKSPACE_ID], activeWorkspaceId: WORKSPACE_ID },
        },
        selectPane,
        splitRight,
        splitDown,
        closePane,
        bindPaneTerminal,
        clearPanePrompt,
        dismissPicker,
      }),
  };
});

import TerminalPanes from './TerminalPanes';

// A pane only mounts its terminal once a socket exists; nothing in these tests
// touches the socket itself (XtermTerminal is stubbed above).
const socket = {} as Socket;

const onDesktop = () => mockUseMobile.mockReturnValue(false);
const onMobile = () => mockUseMobile.mockReturnValue(true);

describe('TerminalPanes (narrow-viewport degradation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  test('a lone EMPTY pane on a phone renders no control chip at all', async () => {
    onMobile();
    workspace = EMPTY_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the only pane on a narrow viewport, empty, where it can neither split nor detach anything',
      should:
        'render no control chip — the chip is opacity-100 on touch, so an empty bordered box would sit in the corner permanently',
      actual: {
        split: screen.queryByTitle('Split right') !== null,
        close: screen.queryByTitle('Close pane') !== null,
        chip: document.querySelector('.backdrop-blur-sm') !== null,
      },
      expected: { split: false, close: false, chip: false },
    });
  });

  test('a lone pane HOLDING a terminal can still detach it, even on a phone', async () => {
    onMobile();
    workspace = SOLO_WORKSPACE;
    render(<TerminalPanes machineId="m1" socket={socket} />);
    await screen.findByTestId('xterm');

    assert({
      given: 'a workspace whose only pane shows a session — one that may no longer exist server-side',
      should:
        'offer close, which detaches the terminal and hands the pane back to the picker; without it that workspace is stuck forever on a terminal that will never connect again',
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

  test('an empty pane picks an agent and gets it running — ONE action, no modal, no name step', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.type(screen.getByLabelText('Starting prompt'), 'fix the build');
    await userEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));

    const [spawnedName, spawnedType] = addAgentTerminal.mock.calls[0] ?? [];
    assert({
      given: 'an empty pane, an agent type (the default) and an optional starting prompt',
      should:
        'spawn the session — auto-named, never prompted for — at the ACTIVE NODE\'s scope and bind it to that pane, in one action',
      actual: {
        spawns: addAgentTerminal.mock.calls.length,
        agentType: spawnedType,
        autoNamed: spawnedName?.startsWith(`${spawnedType}-`),
        bind: bindPaneTerminal.mock.calls[0],
      },
      expected: {
        spawns: 1,
        agentType: 'pagespace-cli',
        autoNamed: true,
        bind: [
          'm1',
          WORKSPACE_ID,
          'pane-1',
          { projectName: 'app', branchName: 'main', name: spawnedName },
          'fix the build',
        ],
      },
    });
  });

  test('the starting prompt is optional — picking an agent alone is enough', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));

    assert({
      given: 'a pick with no starting prompt typed',
      should: 'still spawn and bind, carrying no prompt — the agent just boots to its own',
      actual: {
        spawns: addAgentTerminal.mock.calls.length,
        prompt: bindPaneTerminal.mock.calls[0]?.[4],
      },
      expected: { spawns: 1, prompt: undefined },
    });
  });

  test('a pane made by a split opens its picker FOCUSED', async () => {
    workspace = JUST_SPLIT_WORKSPACE;

    render(<TerminalPanes machineId="m1" socket={socket} />);

    assert({
      given: 'the empty pane a split just created',
      should: 'focus its picker (and consume the pending-picker flag) rather than leave the user facing a blank pane',
      actual: {
        focused: document.activeElement === screen.getByLabelText('Starting prompt'),
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
      actual: document.activeElement === screen.getByLabelText('Starting prompt'),
      expected: false,
    });
  });

  test('a failed spawn leaves the pane empty and its picker usable', async () => {
    addAgentTerminal.mockRejectedValueOnce(new Error('name_in_use'));
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));

    assert({
      given: 'a spawn the API rejected',
      should: 'bind nothing and re-offer the picker — a pane bound to a session that does not exist would connect to nothing',
      actual: {
        bound: bindPaneTerminal.mock.calls.length,
        canRetry: screen.queryByRole('button', { name: 'Spawn agent' }) !== null,
      },
      expected: { bound: 0, canRetry: true },
    });
  });

  test('the spawn is scoped to the WORKSPACE\'s checkout, not the machine root', async () => {
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await userEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));

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

    await userEvent.click(screen.getByRole('button', { name: 'Spawn agent' }));

    assert({
      given: 'a spawn whose pane is gone by the time it resolves',
      should:
        'remove the session it created — the row exists server-side but belongs to no pane, so leaving it would strand a terminal the user never asked for and never saw appear',
      actual: removeAgentTerminal.mock.calls[0]?.[0] === addAgentTerminal.mock.calls[0]?.[0],
      expected: true,
    });
  });
});
