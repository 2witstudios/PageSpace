/**
 * Settings → Local environments (GA wave 3, leaf 5; subsumes [D-5]): the
 * owner's machines across drives, each with its live activity and a link to
 * its drive settings page, and the approvals in force — all from the two
 * owner-only account routes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const mockMachines = vi.fn();
const mockApprovals = vi.fn();
vi.mock('@/hooks/drive-envs/useEnvApprovals', () => ({ useOwnerMachines: () => mockMachines(), useEnvApprovals: () => mockApprovals() }));
const mockPanel = vi.fn();
vi.mock('@/components/agents/EnvActivityPanel', () => ({ EnvActivityPanel: (props: Record<string, unknown>) => { mockPanel(props); return <div data-testid={`activity-${String(props.envId)}`} />; } }));
const mockList = vi.fn();
vi.mock('@/components/settings/EnvApprovalsList', () => ({ EnvApprovalsList: (props: Record<string, unknown>) => { mockList(props); return <div data-testid="approvals-list" />; } }));

import LocalEnvironmentsSettingsPage from '../local-envs/page';

const machine = (id: string, over: Record<string, unknown> = {}) => ({ driveId: 'drive-1', env: { id, driveId: 'drive-1', name: `env-${id}`, substrate: 'local', status: 'connected', label: `${id}-book`, enrolled: true, serverPolicy: { ops: ['exec', 'fs_read'], checkpoint: false }, ownerId: 'me', capabilities: null, paused: false, createdAt: '2026-09-01T00:00:00.000Z', ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  mockMachines.mockReturnValue({ machines: [machine('mac'), machine('linux', { paused: true, status: 'disconnected' })], isLoading: false, isError: false, refetch: vi.fn() });
  mockApprovals.mockReturnValue({ approvals: [{ id: 'ch_1' }], isLoading: false, isError: false, refetch: vi.fn() });
});

describe('Local environments page', () => {
  it('lists every machine the caller owns with its status, what PageSpace may ask of it, a link into its drive settings, and its live activity', () => {
    render(<LocalEnvironmentsSettingsPage />);
    const mac = screen.getByTestId('machine-mac');
    expect(mac).toHaveTextContent('mac-book');
    expect(mac).toHaveTextContent('Connected');
    expect(mac).toHaveTextContent('run commands, read files');
    expect(screen.getByTestId('machine-linux')).toHaveTextContent('Stopped');
    const links = screen.getAllByRole('link', { name: 'open in drive settings' });
    expect(links[0]).toHaveAttribute('href', '/dashboard/drive-1/settings/environments?env=mac');
    expect(screen.getByTestId('activity-mac')).toBeInTheDocument();
    expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ driveId: 'drive-1', envId: 'mac', enabled: true }));
  });

  it('hands the approvals hook\'s result to the revocable list and says terminal-prompt approvals are not listed', () => {
    render(<LocalEnvironmentsSettingsPage />);
    expect(screen.getByTestId('approvals-list')).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ approvals: [{ id: 'ch_1' }], isLoading: false, isError: false }));
    expect(screen.getByText(/terminal prompt live only on that machine/)).toBeInTheDocument();
    expect(screen.getByText(/These run as you/)).toBeInTheDocument();
  });

  it('with no machines, says how to enroll one; an awaiting-enrollment machine shows no activity panel', () => {
    mockMachines.mockReturnValue({ machines: [], isLoading: false, isError: false, refetch: vi.fn() });
    const { rerender } = render(<LocalEnvironmentsSettingsPage />);
    expect(screen.getByText('No machines enrolled')).toBeInTheDocument();
    mockMachines.mockReturnValue({ machines: [machine('new', { enrolled: false, status: 'disconnected' })], isLoading: false, isError: false, refetch: vi.fn() });
    rerender(<LocalEnvironmentsSettingsPage />);
    expect(screen.getByTestId('machine-new')).toHaveTextContent('Awaiting enrollment');
    expect(screen.queryByTestId('activity-new')).toBeNull();
  });
});
