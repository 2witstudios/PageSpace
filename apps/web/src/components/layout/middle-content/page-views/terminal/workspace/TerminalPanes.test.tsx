import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { Socket } from 'socket.io-client';
import type { WorkspaceState } from '@/stores/terminal-workspace/useTerminalWorkspaceStore';

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

/** Two panes side by side in two columns — a layout only a wide screen can make. */
const SPLIT_WORKSPACE: WorkspaceState = {
  columns: [
    { id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'left' } }] },
    { id: 'col-2', panes: [{ id: 'pane-2', scope: { name: 'right' } }] },
  ],
  activePaneId: 'pane-2',
};

let workspace: WorkspaceState = SPLIT_WORKSPACE;

vi.mock('@/stores/terminal-workspace/useTerminalWorkspaceStore', () => ({
  useTerminalWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ workspaces: { m1: workspace }, selectPane, splitRight, splitDown, closePane }),
  selectWorkspace: (machineId: string) => (state: { workspaces: Record<string, WorkspaceState> }) =>
    state.workspaces[machineId],
}));

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
        mountedTerminals: terminals.length,
        hidden: hiddenPanes.length,
      },
      expected: { mountedTerminals: 2, hidden: 1 },
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
      expected: ['m1', 'pane-1'],
    });
  });

  test('a single-pane workspace renders no pane strip on a narrow viewport', async () => {
    onMobile();
    workspace = { columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'solo' } }] }], activePaneId: 'pane-1' };
    render(<TerminalPanes machineId="m1" socket={socket} />);

    await screen.findByTestId('xterm');

    assert({
      given: 'a workspace with nothing hidden',
      should: 'render no pane strip — it exists only to reach panes the collapse hid',
      actual: screen.queryByRole('button', { name: 'solo' }) !== null,
      expected: false,
    });
  });
});
