/**
 * The Development sidebar's wiring: who may see the machine list, and what a
 * session click actually does.
 *
 * The session-click path is the one worth pinning down — it was broken twice in
 * review. It has to do three things in concert: bring the machine's Terminal tab
 * forward (only that tab mounts a workspace, so otherwise the session has
 * nowhere to land), record the intent (the pane region isn't mounted yet, so it
 * cannot be applied now), and navigate.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = vi.fn();
const mockUseAuth = vi.fn();
const mockUseParams = vi.fn<() => { driveId?: string }>(() => ({ driveId: 'drive-1' }));
const mockUsePathname = vi.fn(() => '/dashboard/drive-1/development');

vi.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));

// Spied, not just stubbed: a null/disabled key is HOW the sidebar refuses to
// fetch for a non-admin, so the argument is the security property — asserting
// only that no machine renders would still pass if the gate were dropped,
// since the refusal notice short-circuits the list anyway.
interface DriveMachinesResult {
  machines: { id: string; title: string; updatedAt: string }[];
  isLoading: boolean;
  error: Error | undefined;
  mutate: () => void;
}

const mockUseDriveMachines = vi.fn(
  (driveId: string | null): DriveMachinesResult => ({
    machines: driveId ? [{ id: 'machine-1', title: 'Dev box', updatedAt: '2026-07-12T00:00:00.000Z' }] : [],
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  }),
);

interface AllMachinesResult {
  drives: { driveId: string; driveName: string; machines: { id: string; title: string; updatedAt: string }[] }[];
  isLoading: boolean;
  error: Error | undefined;
  mutate: () => void;
}

const mockUseAllMachines = vi.fn(
  (enabled: boolean): AllMachinesResult => ({
    drives: enabled
      ? [{ driveId: 'drive-1', driveName: 'Alpha', machines: [{ id: 'machine-1', title: 'Dev box', updatedAt: '2026-07-12T00:00:00.000Z' }] }]
      : [],
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  }),
);

vi.mock('@/hooks/useDriveMachines', () => ({
  useDriveMachines: (driveId: string | null) => mockUseDriveMachines(driveId),
  useAllMachines: (enabled: boolean) => mockUseAllMachines(enabled),
}));

vi.mock('@/hooks/useMachineProjects', () => ({
  useMachineProjects: () => ({ projects: [], isLoading: false, addProject: vi.fn(), removeProject: vi.fn() }),
}));
vi.mock('@/hooks/useMachineBranches', () => ({
  useMachineBranches: () => ({ branches: [], isLoading: false, addBranch: vi.fn(), removeBranch: vi.fn() }),
}));
vi.mock('@/hooks/useAgentTerminals', () => ({
  useAgentTerminals: (machineId: string | null) => ({
    agentTerminals: machineId ? [{ name: 'agent-1', agentType: 'claude', createdAt: '2026-07-12' }] : [],
    isLoading: false,
    addAgentTerminal: vi.fn(),
    removeAgentTerminal: vi.fn(),
  }),
}));
vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useIntegrations', () => ({ useProviders: () => ({ providers: [] }) }));

// Sidebar chrome that isn't under test.
vi.mock('@/components/layout/navbar/DriveSwitcher', () => ({ default: () => <div /> }));
vi.mock('../PrimaryNavigation', () => ({ default: () => <div /> }));
vi.mock('../DriveFooter', () => ({ default: () => <div /> }));
vi.mock('../DashboardFooter', () => ({ default: () => <div /> }));

import DevelopmentSidebar from '../DevelopmentSidebar';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';

beforeEach(() => {
  vi.clearAllMocks();
  usePendingSessionStore.setState({ pending: null });
  useMachineTabStore.setState({ tabs: {} });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/development');
});

describe('DevelopmentSidebar', () => {
  test('lists the drive\'s machines for an admin', async () => {
    render(<DevelopmentSidebar />);

    expect(await screen.findByText('Dev box')).toBeDefined();
  });

  test('refuses a non-admin, and asks the API for no machines on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
    expect(screen.queryByText('Dev box')).toBeNull();
    // The load-bearing half: the request is never made, rather than made and
    // discarded. (The server rejects a non-admin too — this is the client half.)
    expect(mockUseDriveMachines).toHaveBeenCalledWith(null);
    expect(mockUseDriveMachines).not.toHaveBeenCalledWith('drive-1');
  });

  test('an admin does fetch the drive\'s machines', () => {
    render(<DevelopmentSidebar />);

    expect(mockUseDriveMachines).toHaveBeenCalledWith('drive-1');
  });

  test('a failed POLL keeps the tree — it does not replace it with an error', () => {
    // The list polls, and SWR keeps the last good data while setting `error` on a
    // failed revalidation. Reporting the error ahead of the data would let one
    // blip tear down every MachineTree, losing its expansion state and the
    // session leaves under it, while the app still holds a good list.
    mockUseDriveMachines.mockReturnValueOnce({
      machines: [{ id: 'machine-1', title: 'Dev box', updatedAt: '2026-07-12T00:00:00.000Z' }],
      isLoading: false,
      error: new Error('blip'),
      mutate: vi.fn(),
    });

    render(<DevelopmentSidebar />);

    expect(screen.getByText('Dev box')).toBeDefined();
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('says nothing about admin rights until auth has resolved', () => {
    // `role` isn't persisted across a reload, so an early refusal would flash at
    // a real admin on every cold load.
    mockUseAuth.mockReturnValue({ user: undefined, isLoading: true });

    render(<DevelopmentSidebar />);

    expect(screen.queryByText(/administrator privileges/i)).toBeNull();
  });

  test('clicking a session focuses the machine\'s Terminal tab, records the intent, and navigates', async () => {
    const user = userEvent.setup();
    // The machine is parked on another tab — the case where the click used to do
    // nothing at all, because only the Terminal tab mounts a workspace.
    useMachineTabStore.getState().setTab('machine-1', 'code');
    render(<DevelopmentSidebar />);

    // Expand the machine to reveal its session leaves.
    await user.click(await screen.findByRole('button', { name: 'Expand' }));
    await user.click(await screen.findByText('agent-1'));

    expect(useMachineTabStore.getState().tabs['machine-1']).toBe('terminal');
    expect(usePendingSessionStore.getState().pending).toMatchObject({
      machineId: 'machine-1',
      scope: { name: 'agent-1' },
    });
    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/development/machine-1');
  });

  test('clicking the machine itself drops a stale session intent', async () => {
    // Picking the machine (not one of its sessions) says "this machine as it is"
    // — an older intent must not follow the user here and take over the pane.
    const user = userEvent.setup();
    usePendingSessionStore.setState({
      pending: { machineId: 'machine-1', scope: { name: 'old-session' } },
    });
    render(<DevelopmentSidebar />);

    await user.click(await screen.findByText('Dev box'));

    expect(usePendingSessionStore.getState().pending).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/development/machine-1');
  });
});

describe('DevelopmentSidebar — GLOBAL mode (no driveId)', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({});
    mockUsePathname.mockReturnValue('/dashboard/development');
  });

  test('lists machines grouped by drive for an admin', async () => {
    render(<DevelopmentSidebar />);

    expect(await screen.findByText('Alpha')).toBeDefined();
    expect(await screen.findByText('Dev box')).toBeDefined();
  });

  test('fetches the global list, not any single drive\'s', () => {
    render(<DevelopmentSidebar />);

    expect(mockUseAllMachines).toHaveBeenCalledWith(true);
    expect(mockUseDriveMachines).toHaveBeenCalledWith(null);
  });

  test('refuses a non-admin, and asks the API for no machines on their behalf', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
    expect(screen.queryByText('Dev box')).toBeNull();
    expect(mockUseAllMachines).toHaveBeenCalledWith(false);
  });

  test('renders multiple drive groups, each with its own machines', async () => {
    mockUseAllMachines.mockReturnValueOnce({
      drives: [
        { driveId: 'drive-1', driveName: 'Alpha', machines: [{ id: 'machine-1', title: 'Box One', updatedAt: '2026-07-12T00:00:00.000Z' }] },
        { driveId: 'drive-2', driveName: 'Beta', machines: [{ id: 'machine-2', title: 'Box Two', updatedAt: '2026-07-12T00:00:00.000Z' }] },
      ],
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
    });

    render(<DevelopmentSidebar />);

    expect(await screen.findByText('Alpha')).toBeDefined();
    expect(screen.getByText('Beta')).toBeDefined();
    expect(screen.getByText('Box One')).toBeDefined();
    expect(screen.getByText('Box Two')).toBeDefined();
  });

  test('an empty global list shows a notice, not an error', () => {
    mockUseAllMachines.mockReturnValueOnce({ drives: [], isLoading: false, error: undefined, mutate: vi.fn() });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/no machines across your drives/i)).toBeDefined();
  });

  test('a failed POLL keeps the tree — it does not replace it with an error', () => {
    mockUseAllMachines.mockReturnValueOnce({
      drives: [{ driveId: 'drive-1', driveName: 'Alpha', machines: [{ id: 'machine-1', title: 'Dev box', updatedAt: '2026-07-12T00:00:00.000Z' }] }],
      isLoading: false,
      error: new Error('blip'),
      mutate: vi.fn(),
    });

    render(<DevelopmentSidebar />);

    expect(screen.getByText('Dev box')).toBeDefined();
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('clicking a machine routes into the GLOBAL detail path, not the drive-scoped one', async () => {
    const user = userEvent.setup();
    render(<DevelopmentSidebar />);

    await user.click(await screen.findByText('Dev box'));

    expect(mockPush).toHaveBeenCalledWith('/dashboard/development/machine-1');
  });
});
