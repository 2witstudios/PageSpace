/**
 * The Development sidebar's wiring: who may see the machine list, and what a
 * workspace click actually does.
 *
 * The workspace-click path is the one worth pinning down — it has to do three
 * things in concert: bring the machine's Terminal tab forward (only that tab
 * mounts a workspace grid, so otherwise the click has nowhere to land), record
 * the intent (the pane region isn't mounted yet, so it cannot be applied now),
 * and navigate.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = vi.fn();
const mockUseAuth = vi.fn();
const mockUseParams = vi.fn<() => { driveId?: string }>(() => ({ driveId: 'drive-1' }));
const mockUsePathname = vi.fn(() => '/dashboard/drive-1/development');
// Defaults to desktop width (matches the real hook's jsdom default — see
// test/setup.ts). Individual tests flip this to exercise the sheet-breakpoint
// (narrow-viewport) branch without needing a real matchMedia listener.
const mockUseBreakpoint = vi.fn(() => false);

vi.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => mockUseBreakpoint() }));

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
vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useIntegrations', () => ({ useProviders: () => ({ providers: [] }) }));

// `WorkspaceLeaves`/`WorkspaceNodeExtras` (rendered by this sidebar) also pull
// `useSyncedWorkspaceActions` from this same module — preserved via
// `importOriginal` so only `useMachineWorkspaceSync` itself is spied on.
const mockUseMachineWorkspaceSync = vi.fn();
vi.mock('@/hooks/useMachineWorkspaceSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMachineWorkspaceSync')>();
  return {
    ...actual,
    useMachineWorkspaceSync: (machineId: string | null) => mockUseMachineWorkspaceSync(machineId),
  };
});

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  post: vi.fn(async () => ({ agentTerminal: { name: 'shell-a1b2c3', agentType: 'shell', resumed: false } })),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

// Sidebar chrome that isn't under test.
vi.mock('@/components/layout/navbar/DriveSwitcher', () => ({ default: () => <div /> }));
vi.mock('../PrimaryNavigation', () => ({ default: () => <div /> }));
vi.mock('../DriveFooter', () => ({ default: () => <div /> }));
vi.mock('../DashboardFooter', () => ({ default: () => <div /> }));

import DevelopmentSidebar from '../DevelopmentSidebar';
import { usePendingWorkspaceStore } from '@/stores/development/usePendingWorkspaceStore';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';
import { useMachineWorkspaceStore, selectMachine } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { useLayoutStore } from '@/stores/useLayoutStore';

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  usePendingWorkspaceStore.setState({ pending: null });
  useMachineTabStore.setState({ tabs: {} });
  useMachineWorkspaceStore.setState({ machines: {} });
  useLayoutStore.setState({ leftSheetOpen: false });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/development');
  mockUseBreakpoint.mockReturnValue(false);
});

describe('DevelopmentSidebar', () => {
  test('lists the drive\'s machines for an admin', async () => {
    render(<DevelopmentSidebar />);

    expect(await screen.findByText('Dev box')).toBeDefined();
  });

  // Regression: `WorkspaceLeaves`/`WorkspaceNodeExtras` render the SAME
  // server-synced workspace tree the Machine page's Terminal tab does, but
  // `MachineView` (the sync hook's OTHER mount point) only mounts once the
  // user navigates INTO a machine. Without mounting the hook here too,
  // expanding a machine's row in this sidebar without ever visiting its page
  // would act on a never-hydrated local store.
  test('mounts useMachineWorkspaceSync for each visible machine row, hydrating it even before the machine is ever opened', async () => {
    render(<DevelopmentSidebar />);

    await screen.findByText('Dev box');
    expect(mockUseMachineWorkspaceSync).toHaveBeenCalledWith('machine-1');
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
    // workspace leaves under it, while the app still holds a good list.
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

  test('an initial (cold) load shows a distinct loading state, not the empty notice', () => {
    mockUseDriveMachines.mockReturnValueOnce({
      machines: [],
      isLoading: true,
      error: undefined,
      mutate: vi.fn(),
    });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/loading machines/i)).toBeDefined();
    expect(screen.queryByText(/no machines in this drive/i)).toBeNull();
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('a genuinely empty drive shows the empty notice, not "failed"', () => {
    mockUseDriveMachines.mockReturnValueOnce({
      machines: [],
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
    });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/no machines in this drive yet/i)).toBeDefined();
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('a failed INITIAL load (nothing to fall back on) offers a retry that revalidates', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseDriveMachines.mockReturnValueOnce({
      machines: [],
      isLoading: false,
      error: new Error('network down'),
      mutate,
    });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/failed to load machines/i)).toBeDefined();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    // Called with ZERO arguments: the button's onClick hands React's click
    // MouseEvent to whatever it's wired to, and SWR's `mutate` treats a first
    // argument as replacement cache DATA rather than "revalidate now" — so a
    // naive `onRetry={mutate}` would silently corrupt the machines list
    // instead of refetching it. Pinning the call shape catches that class of
    // bug even though `toHaveBeenCalledTimes` alone would not.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith();
  });

  test('a retry IN FLIGHT shows the loading state, not a rerun of the stale error', () => {
    // SWR sets `isLoading` back to `true` on revalidation whenever cached data
    // is still `undefined` — exactly what a failed fetch leaves behind — while
    // `error` stays at its stale, pre-retry value until the new attempt
    // settles. Both are true at once mid-retry, so the guard chain order
    // matters: loading must win, or clicking Retry looks like it did nothing.
    const staleError = new Error('network down');
    mockUseDriveMachines.mockReturnValueOnce({
      machines: [],
      isLoading: false,
      error: staleError,
      mutate: vi.fn(),
    });
    const { rerender } = render(<DevelopmentSidebar />);
    expect(screen.getByText(/failed to load machines/i)).toBeDefined();

    mockUseDriveMachines.mockReturnValueOnce({
      machines: [],
      isLoading: true,
      error: staleError,
      mutate: vi.fn(),
    });
    rerender(<DevelopmentSidebar />);

    expect(screen.getByText(/loading machines/i)).toBeDefined();
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('closes the mobile sheet after navigating to a machine, at the sheet breakpoint', async () => {
    const user = userEvent.setup();
    mockUseBreakpoint.mockReturnValue(true);
    useLayoutStore.setState({ leftSheetOpen: true });

    render(<DevelopmentSidebar />);
    await user.click(await screen.findByText('Dev box'));

    expect(useLayoutStore.getState().leftSheetOpen).toBe(false);
  });

  test('leaves the sheet alone at desktop width', async () => {
    const user = userEvent.setup();
    mockUseBreakpoint.mockReturnValue(false);
    useLayoutStore.setState({ leftSheetOpen: true });

    render(<DevelopmentSidebar />);
    await user.click(await screen.findByText('Dev box'));

    expect(useLayoutStore.getState().leftSheetOpen).toBe(true);
  });

  test('says nothing about admin rights until auth has resolved', () => {
    // `role` isn't persisted across a reload, so an early refusal would flash at
    // a real admin on every cold load.
    mockUseAuth.mockReturnValue({ user: undefined, isLoading: true });

    render(<DevelopmentSidebar />);

    expect(screen.queryByText(/administrator privileges/i)).toBeNull();
  });

  test('clicking a workspace focuses the machine\'s Terminal tab, records the intent, and navigates', async () => {
    const user = userEvent.setup();
    // The machine is parked on another tab — the case where the click used to do
    // nothing at all, because only the Terminal tab mounts a workspace grid.
    useMachineTabStore.getState().setTab('machine-1', 'code');
    // Seeded explicitly: rendering the sidebar no longer fabricates a first
    // workspace, so a machine only has rows the user actually opened.
    useMachineWorkspaceStore.getState().ensureMachine('machine-1');
    useMachineWorkspaceStore.getState().createWorkspace('machine-1');
    render(<DevelopmentSidebar />);

    await user.click(await screen.findByRole('button', { name: 'Expand' }));
    await user.click(await screen.findByText('Workspace 1'));

    const workspaceId = Object.keys(selectMachine('machine-1')(useMachineWorkspaceStore.getState())!.workspaces)[0];

    // The row's click is deferred (so a double-click-to-rename doesn't also
    // navigate) and cancelled only if a second click follows — see
    // WorkspaceLeaves.tsx's `pendingSelectTimer`.
    await waitFor(() => {
      expect(useMachineTabStore.getState().tabs['machine-1']).toBe('terminal');
    });
    expect(usePendingWorkspaceStore.getState().pending).toEqual({ machineId: 'machine-1', workspaceId });
    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/development/machine-1');
  });

  test('the machine row\'s single "+" palette spawns a new terminal and drives the same click flow', async () => {
    const user = userEvent.setup();
    render(<DevelopmentSidebar />);

    await user.click(await screen.findByTitle('Add…'));
    await user.click(await screen.findByRole('option', { name: 'Shell' }));

    await waitFor(() => {
      const machine = selectMachine('machine-1')(useMachineWorkspaceStore.getState())!;
      // ONE, not two. This used to expect two: rendering the sidebar fabricated a
      // "Workspace 1" for every machine, and the spawn added a second beside it.
      expect(Object.keys(machine.workspaces).length).toBe(1);
      expect(usePendingWorkspaceStore.getState().pending).toEqual({
        machineId: 'machine-1',
        workspaceId: machine.activeWorkspaceId,
      });
      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/development/machine-1');
    });
  });

  test('clicking the machine itself drops a stale workspace intent', async () => {
    // Picking the machine (not one of its workspaces) says "this machine as it
    // is" — an older intent must not follow the user here and take over the pane.
    const user = userEvent.setup();
    usePendingWorkspaceStore.setState({
      pending: { machineId: 'machine-1', workspaceId: 'stale-workspace' },
    });
    render(<DevelopmentSidebar />);

    await user.click(await screen.findByText('Dev box'));

    expect(usePendingWorkspaceStore.getState().pending).toBeNull();
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
    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
  });

  test('an initial (cold) load shows a distinct loading state, not the empty notice', () => {
    mockUseAllMachines.mockReturnValueOnce({ drives: [], isLoading: true, error: undefined, mutate: vi.fn() });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/loading machines/i)).toBeDefined();
    expect(screen.queryByText(/no machines across your drives/i)).toBeNull();
  });

  test('a failed INITIAL load offers a retry that revalidates the global list', async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockUseAllMachines.mockReturnValueOnce({ drives: [], isLoading: false, error: new Error('boom'), mutate });

    render(<DevelopmentSidebar />);

    expect(screen.getByText(/failed to load machines/i)).toBeDefined();
    await user.click(screen.getByRole('button', { name: /retry/i }));

    // Same call-shape guard as the drive-scoped retry test: a naive
    // `onRetry={mutate}` hands React's click MouseEvent to SWR's `mutate` as
    // replacement cache data instead of revalidating.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith();
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
