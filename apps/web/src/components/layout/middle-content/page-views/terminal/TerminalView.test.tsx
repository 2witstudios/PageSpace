import { describe, test, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

// Record every tab body's mount/unmount so we can prove the shell only ever
// mounts the ACTIVE tab (lazy mount) and unmounts it on switch.
const lifecycle: string[] = [];

function tabDouble(name: string) {
  return ({ machineId }: { machineId: string }) => {
    useEffect(() => {
      lifecycle.push(`mount:${name}`);
      return () => {
        lifecycle.push(`unmount:${name}`);
      };
    }, []);
    return <div data-testid={`${name}-body`}>{name}:{machineId}</div>;
  };
}

vi.mock('./tabs/TerminalTab', () => ({ default: tabDouble('terminal') }));
vi.mock('./tabs/CodeTab', () => ({ default: tabDouble('code') }));
vi.mock('./tabs/DiffTab', () => ({ default: tabDouble('diff') }));
vi.mock('./tabs/SettingsTab', () => ({ default: tabDouble('settings') }));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const mockUseAuth = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));

// motion.div → a plain div so the shell renders synchronously in jsdom.
vi.mock('motion/react', () => ({
  motion: new Proxy({}, { get: () => (props: Record<string, unknown>) => <div {...props} /> }),
}));

import TerminalView from './TerminalView';

const asAdmin = () => mockUseAuth.mockReturnValue({ user: { role: 'admin' } });

describe('TerminalView (Machine 4-tab shell)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.length = 0;
  });

  test('mounts only the Terminal tab body on load — not all four', () => {
    asAdmin();
    render(<TerminalView pageId="machine-1" />);

    assert({
      given: 'a freshly-rendered Machine page',
      should: 'mount only the default Terminal tab, leaving Code/Diff/Settings unmounted',
      actual: lifecycle,
      expected: ['mount:terminal'],
    });
  });

  test('passes the pageId down to the tab as machineId', () => {
    asAdmin();
    render(<TerminalView pageId="machine-42" />);

    assert({
      given: 'pageId="machine-42"',
      should: 'render the Terminal tab body scoped to that machineId',
      actual: screen.getByTestId('terminal-body').textContent,
      expected: 'terminal:machine-42',
    });
  });

  test('switching tabs mounts the newly-selected tab and unmounts the previous one', async () => {
    asAdmin();
    render(<TerminalView pageId="machine-1" />);

    await userEvent.click(screen.getByRole('tab', { name: /code/i }));

    assert({
      given: 'the user switches from Terminal to Code',
      should: 'mount the Code body and unmount the Terminal body (lazy, one at a time)',
      actual: lifecycle,
      expected: ['mount:terminal', 'unmount:terminal', 'mount:code'],
    });
  });

  test('non-admin users see the gate and no tabs mount', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' } });
    render(<TerminalView pageId="machine-1" />);

    assert({
      given: 'a non-admin user',
      should: 'show the admin-only notice and mount no tab bodies',
      actual: { notice: !!screen.queryByText(/requires administrator privileges/i), lifecycle },
      expected: { notice: true, lifecycle: [] },
    });
  });
});
