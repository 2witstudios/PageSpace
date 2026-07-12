/**
 * The Development surface's detail region — the composition, not its parts.
 *
 * Every piece this layout uses is unit-tested; what wasn't was how they fit
 * together, and that's where six review passes kept finding bugs. So these tests
 * pin the three properties that were actually broken at some point:
 *   - the sticky machine set converges instead of re-rendering forever, and
 *     keeps its identity so the keep-alive host doesn't churn its LRU;
 *   - a failed fetch says "failed", not "your machine was deleted";
 *   - a machine that vanishes stops being DISPLAYED but is not evicted (which
 *     would disconnect its terminal).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseAuth = vi.fn();
const mockUseDriveMachines = vi.fn();
/** Every render of the stubbed keep-alive host, so we can assert on what it was handed. */
const hostRenders: { activePageId: string | null; machineIds: readonly string[] }[] = [];

vi.mock('next/navigation', () => ({
  useParams: () => ({ driveId: 'drive-1' }),
  usePathname: () => '/dashboard/drive-1/development/machine-1',
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('@/hooks/useDriveMachines', () => ({ useDriveMachines: () => mockUseDriveMachines() }));

vi.mock('@/components/layout/middle-content/MachineKeepAliveHost', () => ({
  default: (props: { activePageId: string | null; machineIds: readonly string[] }) => {
    hostRenders.push({ activePageId: props.activePageId, machineIds: props.machineIds });
    return <div data-testid="keepalive-host" />;
  },
}));

import DevelopmentLayout from '../layout';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';

const machine = (id: string) => ({ id, title: id, updatedAt: '2026-07-12T00:00:00.000Z' });

const driveMachines = (over: Partial<{ machines: ReturnType<typeof machine>[]; isLoading: boolean; error: Error | undefined }> = {}) => ({
  machines: over.machines ?? [machine('machine-1')],
  isLoading: over.isLoading ?? false,
  error: over.error,
  mutate: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  hostRenders.length = 0;
  usePendingSessionStore.setState({ pending: null });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseDriveMachines.mockReturnValue(driveMachines());
});

describe('DevelopmentLayout', () => {
  test('hands the selected machine and its drive\'s machines to the keep-alive host', () => {
    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(hostRenders.at(-1)).toEqual({ activePageId: 'machine-1', machineIds: ['machine-1'] });
  });

  test('settles instead of re-rendering forever', () => {
    // useStickyMachineIds sets state DURING render. If its key were derived from
    // the array's identity rather than its contents it would loop, because SWR
    // hands back a fresh array every render.
    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(hostRenders.length).toBeLessThanOrEqual(3);
  });

  test('keeps the machine-id list stable across a revalidation that changes nothing', () => {
    // A new array identity each render would look to the host like a changed
    // machine set, which is what drives LRU eviction — i.e. terminal teardown.
    const { rerender } = render(<DevelopmentLayout>{null}</DevelopmentLayout>);
    const first = hostRenders.at(-1)!.machineIds;

    mockUseDriveMachines.mockReturnValue(driveMachines({ machines: [machine('machine-1')] }));
    rerender(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(hostRenders.at(-1)!.machineIds).toBe(first);
  });

  test('a failed fetch reports the failure — it does not claim the machine is gone', () => {
    // SWR reports isLoading:false with no data on the error path, which is
    // indistinguishable from "no such machine" unless error is checked first.
    mockUseDriveMachines.mockReturnValue(driveMachines({ machines: [], error: new Error('boom') }));

    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(screen.getByText(/failed to load machines/i)).toBeDefined();
    expect(screen.queryByText(/machine not found/i)).toBeNull();
  });

  test('a failed POLL does not blank out a machine we can still show', () => {
    // The list polls, and SWR keeps the last good data while setting `error` on a
    // failed revalidation. Reporting the error ahead of the data would let one
    // blip of a background poll replace a working machine with an error notice.
    mockUseDriveMachines.mockReturnValue(driveMachines({ machines: [machine('machine-1')], error: new Error('blip') }));

    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(screen.queryByText(/failed to load machines/i)).toBeNull();
    expect(hostRenders.at(-1)!.activePageId).toBe('machine-1');
  });

  test('a machine that vanishes stops being shown, but is NOT evicted', () => {
    // It may have been deleted — or the per-page permission check may have
    // swallowed a DB error and reported "cannot view". Stop DISPLAYING it either
    // way, but keep it in the mountable set: evicting it would unmount MachineView
    // and disconnect a terminal that might be perfectly alive.
    //
    // Must be a rerender, NOT cleanup() + render: a fresh mount rebuilds the
    // sticky set from the (now empty) fetch, which would evict the machine and
    // make this test pass while proving the opposite of its name.
    const { rerender } = render(<DevelopmentLayout>{null}</DevelopmentLayout>);
    expect(hostRenders.at(-1)!.machineIds).toContain('machine-1');

    mockUseDriveMachines.mockReturnValue(driveMachines({ machines: [] }));
    rerender(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(screen.getByText(/machine not found/i)).toBeDefined();
    // Not displayed…
    expect(hostRenders.at(-1)!.activePageId).toBeNull();
    // …but still mountable, so its terminal is not torn down.
    expect(hostRenders.at(-1)!.machineIds).toContain('machine-1');
  });

  test('says nothing about admin rights until auth resolves', () => {
    mockUseAuth.mockReturnValue({ user: undefined, isLoading: true });

    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(screen.queryByText(/administrator privileges/i)).toBeNull();
  });

  test('refuses a non-admin', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
  });

  test('does not open a session into a machine the host is keeping HIDDEN', () => {
    // The drain must gate on what is DISPLAYED, not on what the URL selects. If a
    // machine is transiently missing from the list the host hides every pane, and
    // opening a session then mounts an xterm inside a `display:none` container —
    // fit() measures a zero-sized box and the PTY is created at a bogus geometry,
    // wrapping its output for the life of the session.
    mockUseDriveMachines.mockReturnValue(driveMachines({ machines: [] }));
    usePendingSessionStore.setState({ pending: { machineId: 'machine-1', scope: { name: 'agent-1' } } });

    render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    expect(hostRenders.at(-1)!.activePageId).toBeNull();
    // Held, not applied — it converges once the machine is displayed again.
    expect(useMachineWorkspaceStore.getState().workspaces['machine-1']).toBeUndefined();
  });

  test('drops an unconverged session intent when the surface is left', () => {
    // The store is a module singleton: an intent left behind would still be
    // sitting there on the next visit, ready to fire into whatever pane is active.
    usePendingSessionStore.setState({ pending: { machineId: 'machine-9', scope: { name: 'agent-1' } } });
    const { unmount } = render(<DevelopmentLayout>{null}</DevelopmentLayout>);

    unmount();

    expect(usePendingSessionStore.getState().pending).toBeNull();
  });
});
