/**
 * The GLOBAL Development surface's detail region — the driveless twin of
 * `[driveId]/development/__tests__/layout.test.tsx`. Same properties matter
 * here: the sticky machine set converges and keeps its identity, a failed
 * fetch says "failed" (not "deleted"), and a machine that vanishes from the
 * global list stops being DISPLAYED without being evicted.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseAuth = vi.fn();
const mockUseAllMachines = vi.fn();
const hostRenders: { activePageId: string | null; machineIds: readonly string[] }[] = [];

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/development/machine-1',
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('@/hooks/useDriveMachines', () => ({ useAllMachines: (enabled: boolean) => mockUseAllMachines(enabled) }));

vi.mock('@/components/layout/middle-content/MachineKeepAliveHost', () => ({
  default: (props: { activePageId: string | null; machineIds: readonly string[] }) => {
    hostRenders.push({ activePageId: props.activePageId, machineIds: props.machineIds });
    return <div data-testid="keepalive-host" />;
  },
}));

import GlobalDevelopmentLayout from '../layout';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';

const machine = (id: string) => ({ id, title: id, updatedAt: '2026-07-12T00:00:00.000Z' });
const group = (driveId: string, machines: ReturnType<typeof machine>[]) => ({
  driveId,
  driveName: driveId,
  machines,
});

const allMachines = (over: Partial<{ drives: ReturnType<typeof group>[]; isLoading: boolean; error: Error | undefined }> = {}) => ({
  drives: over.drives ?? [group('drive-1', [machine('machine-1')])],
  isLoading: over.isLoading ?? false,
  error: over.error,
  mutate: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  hostRenders.length = 0;
  usePendingSessionStore.setState({ pending: null });
  useMachineWorkspaceStore.setState({ machines: {} });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  mockUseAllMachines.mockReturnValue(allMachines());
});

describe('GlobalDevelopmentLayout', () => {
  test('hands the selected machine and the flattened cross-drive list to the keep-alive host', () => {
    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(hostRenders.at(-1)).toEqual({ activePageId: 'machine-1', machineIds: ['machine-1'] });
  });

  test('flattens machines across every drive group', () => {
    mockUseAllMachines.mockReturnValue(
      allMachines({ drives: [group('drive-1', [machine('machine-1')]), group('drive-2', [machine('machine-2')])] }),
    );

    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(hostRenders.at(-1)!.machineIds).toEqual(['machine-1', 'machine-2']);
  });

  test('fetches with the admin gate, same as the sidebar', () => {
    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(mockUseAllMachines).toHaveBeenCalledWith(true);
  });

  test('a non-admin fires no request', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(mockUseAllMachines).toHaveBeenCalledWith(false);
  });

  test('settles instead of re-rendering forever', () => {
    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(hostRenders.length).toBeLessThanOrEqual(3);
  });

  test('keeps the machine-id list stable across a revalidation that changes nothing', () => {
    const { rerender } = render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);
    const first = hostRenders.at(-1)!.machineIds;

    mockUseAllMachines.mockReturnValue(allMachines({ drives: [group('drive-1', [machine('machine-1')])] }));
    rerender(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(hostRenders.at(-1)!.machineIds).toBe(first);
  });

  test('a failed fetch reports the failure — it does not claim the machine is gone', () => {
    mockUseAllMachines.mockReturnValue(allMachines({ drives: [], error: new Error('boom') }));

    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(screen.getByText(/failed to load machines/i)).toBeDefined();
    expect(screen.queryByText(/machine not found/i)).toBeNull();
  });

  test('a machine that vanishes stops being shown, but is NOT evicted', () => {
    const { rerender } = render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);
    expect(hostRenders.at(-1)!.machineIds).toContain('machine-1');

    mockUseAllMachines.mockReturnValue(allMachines({ drives: [] }));
    rerender(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(screen.getByText(/machine not found/i)).toBeDefined();
    expect(hostRenders.at(-1)!.activePageId).toBeNull();
    expect(hostRenders.at(-1)!.machineIds).toContain('machine-1');
  });

  test('refuses a non-admin', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(screen.getByText(/administrator privileges/i)).toBeDefined();
  });

  test('says nothing about admin rights until auth resolves', () => {
    mockUseAuth.mockReturnValue({ user: undefined, isLoading: true });

    render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    expect(screen.queryByText(/administrator privileges/i)).toBeNull();
  });

  test('drops an unconverged session intent when the surface is left', () => {
    usePendingSessionStore.setState({ pending: { machineId: 'machine-9', scope: { name: 'agent-1' } } });
    const { unmount } = render(<GlobalDevelopmentLayout>{null}</GlobalDevelopmentLayout>);

    unmount();

    expect(usePendingSessionStore.getState().pending).toBeNull();
  });
});
