import { describe, test, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// Record every tab body's mount/unmount so we can prove the shell only ever
// mounts the ACTIVE tab (lazy mount) and unmounts it on switch.
const lifecycle: string[] = [];

function tabDouble(name: string) {
  const Double = ({ machineId }: { machineId: string }) => {
    useEffect(() => {
      lifecycle.push(`mount:${name}`);
      return () => {
        lifecycle.push(`unmount:${name}`);
      };
    }, []);
    return <div data-testid={`${name}-body`}>{name}:{machineId}</div>;
  };
  Double.displayName = `TabDouble(${name})`;
  return Double;
}

/** Every render's props for the Terminal tab double, so `embedded` threading can be asserted. */
const terminalTabProps: { machineId: string; embedded?: boolean }[] = [];
const TerminalDouble = tabDouble('terminal');

vi.mock('./tabs/TerminalTab', () => ({
  default: ({ machineId, embedded }: { machineId: string; embedded?: boolean }) => {
    terminalTabProps.push({ machineId, embedded });
    return <TerminalDouble machineId={machineId} />;
  },
}));
vi.mock('./tabs/FilesTab', () => ({ default: tabDouble('files') }));
vi.mock('./tabs/DiffTab', () => ({ default: tabDouble('diff') }));
vi.mock('./tabs/SettingsTab', () => ({ default: tabDouble('settings') }));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const mockUseAuth = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));

const mockUseMachineWorkspaceSync = vi.fn();
vi.mock('@/hooks/useMachineWorkspaceSync', () => ({
  useMachineWorkspaceSync: (machineId: string | null) => mockUseMachineWorkspaceSync(machineId),
}));

// motion.div → a plain div so the shell renders synchronously in jsdom.
// Strip the animation-only props (initial/animate/exit/transition) so they
// don't leak onto the DOM node and trigger React unknown-prop warnings.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: () =>
        ({ initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => (
          <div {...rest} />
        ),
    },
  ),
}));

import MachineView from './MachineView';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';

const asAdmin = () => mockUseAuth.mockReturnValue({ user: { role: 'admin' } });

describe('MachineView (Machine 4-tab shell)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.length = 0;
    terminalTabProps.length = 0;
    // The active tab now lives in a module-singleton store, so a test that
    // switches tabs would otherwise leave the next one parked on that tab.
    useMachineTabStore.setState({ tabs: {} });
  });

  test('mounts only the Terminal tab body on load — not all four', () => {
    asAdmin();
    render(<MachineView pageId="machine-1" />);

    assert({
      given: 'a freshly-rendered Machine page',
      should: 'mount only the default Terminal tab, leaving Files/Diff/Settings unmounted',
      actual: lifecycle,
      expected: ['mount:terminal'],
    });
  });

  test('passes the pageId down to the tab as machineId', () => {
    asAdmin();
    render(<MachineView pageId="machine-42" />);

    assert({
      given: 'pageId="machine-42"',
      should: 'render the Terminal tab body scoped to that machineId',
      actual: screen.getByTestId('terminal-body').textContent,
      expected: 'terminal:machine-42',
    });
  });

  test('switching tabs mounts the newly-selected tab and unmounts the previous one', async () => {
    asAdmin();
    render(<MachineView pageId="machine-1" />);

    await userEvent.click(screen.getByRole('tab', { name: /files/i }));

    assert({
      given: 'the user switches from Terminal to Files',
      should: 'mount the Files body and unmount the Terminal body (lazy, one at a time)',
      actual: lifecycle,
      expected: ['mount:terminal', 'unmount:terminal', 'mount:files'],
    });
  });

  test('standalone (default) leaves the Terminal tab\'s own tree — embedded is unset', () => {
    asAdmin();
    render(<MachineView pageId="machine-1" />);

    assert({
      given: 'MachineView rendered with no embedded prop (the drive view\'s standalone Machine page)',
      should: 'default embedded to false and pass it through to TerminalTab, which keeps its inner tree',
      actual: terminalTabProps.at(-1)?.embedded,
      expected: false,
    });
  });

  test('embedded=true threads through to the Terminal tab, which drops its redundant inner tree', () => {
    asAdmin();
    render(<MachineView pageId="machine-1" embedded />);

    assert({
      given: 'MachineView rendered with embedded (the Development surface, via MachineKeepAliveHost)',
      should: 'pass embedded=true through to TerminalTab',
      actual: terminalTabProps.at(-1)?.embedded,
      expected: true,
    });
  });

  test('non-admin users see the gate and no tabs mount', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' } });
    render(<MachineView pageId="machine-1" />);

    assert({
      given: 'a non-admin user',
      should: 'show the admin-only notice and mount no tab bodies',
      actual: { notice: !!screen.queryByText(/requires administrator privileges/i), lifecycle },
      expected: { notice: true, lifecycle: [] },
    });
  });

  // Regression (CodeRabbit): a non-admin viewer never sees the tabs
  // useMachineWorkspaceSync exists for, so it must not fetch the workspace
  // list or join the socket room on their behalf.
  test('non-admin users pass null to useMachineWorkspaceSync — no workspace fetch/socket join on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' } });
    render(<MachineView pageId="machine-1" />);

    assert({
      given: 'a non-admin user',
      should: 'call useMachineWorkspaceSync with null rather than skipping the hook call (rules of hooks)',
      actual: mockUseMachineWorkspaceSync.mock.calls.at(-1)?.[0],
      expected: null,
    });
  });

  test('admin users pass the real pageId to useMachineWorkspaceSync', () => {
    asAdmin();
    render(<MachineView pageId="machine-1" />);

    assert({
      given: 'an admin user',
      should: 'call useMachineWorkspaceSync with the machine\'s own pageId',
      actual: mockUseMachineWorkspaceSync.mock.calls.at(-1)?.[0],
      expected: 'machine-1',
    });
  });
});
