/**
 * The Agents console's list header — three CTAs (New Drive, New Agent, New
 * Session) above what used to be a bare conversations list.
 *
 * The properties worth pinning:
 * - "New Session" mirrors `AgentsSidebar`'s own admin gate: sandboxes are
 *   admin-only everywhere else in this console, so a non-admin must not see
 *   this button here either, even though "New Drive"/"New Agent" (ordinary
 *   permission-gated actions, not admin-only) stay visible.
 * - Drive-scoped, "New Session"/"New Agent" act on the current drive
 *   directly. Global (no `driveId`), both go through a drive picker first —
 *   neither creation path has anywhere else to put the result.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockUseAuth = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));

interface PageAgentsResult {
  agentsByDrive: {
    driveId: string;
    driveName: string;
    agentCount: number;
    agents: { id: string; title: string | null; driveId: string }[];
  }[];
  isLoading: boolean;
  isError: boolean;
  mutate: () => void;
}

const AGENTS_BY_DRIVE: PageAgentsResult['agentsByDrive'] = [
  {
    driveId: 'drive-1',
    driveName: 'Alpha',
    agentCount: 1,
    agents: [{ id: 'agent-1', title: 'Researcher', driveId: 'drive-1' }],
  },
];

const defaultPageAgents = (_driveId?: string, _options?: { enabled?: boolean }): PageAgentsResult => ({
  agentsByDrive: AGENTS_BY_DRIVE,
  isLoading: false,
  isError: false,
  mutate: vi.fn(),
});
const mockUsePageAgents = vi.fn(defaultPageAgents);
vi.mock('@/hooks/page-agents/usePageAgents', () => ({
  usePageAgents: (driveId?: string, options?: { enabled?: boolean }) => mockUsePageAgents(driveId, options),
}));

import AgentsListHeader from '../AgentsListHeader';
import { useDriveStore, type Drive } from '@/hooks/useDrive';
import { useUIStore } from '@/stores/useUIStore';

const driveFixture = (id: string, name: string): Drive => ({
  id,
  name,
  slug: name.toLowerCase(),
  ownerId: 'user-1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUsePageAgents.mockReturnValue({ agentsByDrive: AGENTS_BY_DRIVE, isLoading: false, isError: false, mutate: vi.fn() });
  mockUseAuth.mockReturnValue({ user: { role: 'admin' }, isLoading: false });
  useDriveStore.setState({ drives: [driveFixture('drive-1', 'Alpha'), driveFixture('drive-2', 'Beta')] });
  useUIStore.setState({ quickCreateOpen: false, quickCreateParentOverride: undefined });
});

describe('AgentsListHeader', () => {
  test('drive-scoped, admin: renders the title and all three CTAs', () => {
    render(<AgentsListHeader driveId="drive-1" />);

    expect(screen.getByText('Agents')).toBeDefined();
    expect(screen.getByRole('button', { name: /New Drive/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /New Agent/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /New Session/ })).toBeDefined();
  });

  test('non-admin: "New Session" is hidden, but "New Drive"/"New Agent" stay visible', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'user' }, isLoading: false });

    render(<AgentsListHeader driveId="drive-1" />);

    expect(screen.getByRole('button', { name: /New Drive/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /New Agent/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /New Session/ })).toBeNull();
    // The agent picker's roster is spawn-only data — a non-admin can't reach
    // the palette that would use it, so the fetch is disabled entirely.
    expect(mockUsePageAgents).toHaveBeenCalledWith(undefined, { enabled: false });
  });

  test('drive-scoped: "New Session" opens the spawn palette directly, scoped to this drive', async () => {
    const user = userEvent.setup();
    render(<AgentsListHeader driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /New Session/ }));

    expect(await screen.findByText('Choose an agent to start a session with in Alpha')).toBeDefined();
    expect(screen.getByText('Researcher')).toBeDefined();
    // The global-only drive picker must never appear for a drive-scoped spawn.
    // `CommandDialog`'s title/description render outside its Radix `DialogContent`
    // (so it's queryable even while closed) — assert on the picker's actual
    // content instead, which IS gated on `open`.
    expect(screen.queryByPlaceholderText('Search drives…')).toBeNull();
  });

  test('drive-scoped: "New Agent" opens Quick Create scoped to the drive root', async () => {
    const user = userEvent.setup();
    render(<AgentsListHeader driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /New Agent/ }));

    expect(useUIStore.getState().quickCreateOpen).toBe(true);
    expect(useUIStore.getState().quickCreateParentOverride).toBeNull();
  });

  test('"New Drive" opens the create-drive dialog', async () => {
    const user = userEvent.setup();
    render(<AgentsListHeader driveId="drive-1" />);

    await user.click(screen.getByRole('button', { name: /New Drive/ }));

    expect(await screen.findByText('Create a new drive')).toBeDefined();
  });

  test('global (no driveId): "New Session" opens a drive picker first, then the spawn palette scoped to the pick', async () => {
    const user = userEvent.setup();
    render(<AgentsListHeader />);

    await user.click(screen.getByRole('button', { name: /New Session/ }));
    expect(await screen.findByText('Choose a drive')).toBeDefined();

    await user.click(screen.getByText('Alpha'));

    expect(await screen.findByText('Choose an agent to start a session with in Alpha')).toBeDefined();
    expect(screen.queryByPlaceholderText('Search drives…')).toBeNull();
  });

  test('global (no driveId): the session picker offers "Global Assistant", which skips straight to naming a drive-less session', async () => {
    const user = userEvent.setup();
    render(<AgentsListHeader />);

    await user.click(screen.getByRole('button', { name: /New Session/ }));
    expect(await screen.findByText('Global Assistant')).toBeDefined();

    await user.click(screen.getByText('Global Assistant'));

    // Straight to the naming step — no drive was picked, so no target step.
    expect(await screen.findByPlaceholderText('Global Assistant')).toBeDefined();
    expect(screen.getByText('Leave blank to use "Global Assistant"')).toBeDefined();
    expect(screen.queryByPlaceholderText('Search drives…')).toBeNull();
  });

  test('global (no driveId): "New Agent" opens a drive picker, then navigates into the picked drive without opening Quick Create until that drive is live', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgentsListHeader />);

    await user.click(screen.getByRole('button', { name: /New Agent/ }));
    expect(await screen.findByText('Choose a drive')).toBeDefined();
    // A drive-less assistant session is only a valid target for "New
    // Session" — the agent flow needs a real drive to navigate into.
    expect(screen.queryByText('Global Assistant')).toBeNull();

    await user.click(screen.getByText('Beta'));

    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-2/agents');
    // Quick Create must not open before the route (and thus QuickCreatePalette's
    // own `useParams()`-derived driveId) has actually caught up — opening in
    // the same tick as `router.push` would race a still-in-flight navigation.
    expect(useUIStore.getState().quickCreateOpen).toBe(false);

    // The parent (AgentsSurface) re-renders this component with the new
    // driveId once the route lands — simulated here by re-rendering with the
    // prop the real navigation would eventually produce.
    rerender(<AgentsListHeader driveId="drive-2" />);

    await waitFor(() => expect(useUIStore.getState().quickCreateOpen).toBe(true));
  });
});
