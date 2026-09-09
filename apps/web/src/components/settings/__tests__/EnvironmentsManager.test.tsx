/**
 * Drive settings → Environments (GA wave 3, leaf 4). The list-and-detail
 * shape: a local row opens the editor; the OWNER gets live toggles, Stop /
 * Resume and the activity panel; a drive admin who did not enrol the machine
 * gets the same page read-only with a line naming the owner, and keeps
 * Revoke. The effective capability is `intersectCapabilities` over what the
 * machine advertised and what PageSpace allows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUseDriveEnvs = vi.fn();
vi.mock('@/hooks/drive-envs/useDriveEnvs', () => ({ useDriveEnvs: (...args: unknown[]) => mockUseDriveEnvs(...args) }));
const mockUseAuth = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
const mockPatch = vi.fn();
const mockDel = vi.fn();
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({ patch: (...args: unknown[]) => mockPatch(...args), del: (...args: unknown[]) => mockDel(...args), fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args) }));
const mockPanel = vi.fn();
vi.mock('@/components/agents/EnvActivityPanel', () => ({ EnvActivityPanel: (props: Record<string, unknown>) => { mockPanel(props); return <div data-testid="activity-panel" />; } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const mockStartEditing = vi.fn();
const mockEndEditing = vi.fn();
vi.mock('@/stores/useEditingStore', () => ({ useEditingStore: { getState: () => ({ startEditing: mockStartEditing, endEditing: mockEndEditing }) } }));

import { EnvironmentsManager } from '../EnvironmentsManager';
import { ownerDisplayName } from '../EnvironmentEditor';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

const OWNER = 'user-owner';
const ADMIN = 'user-admin';
const mac: Extract<DriveEnvDTO, { substrate: 'local' }> = { id: 'env-mac', driveId: 'drive-1', name: 'mac', substrate: 'local', status: 'connected', label: 'jono-macstudio', enrolled: true, serverPolicy: { ops: ['fs_read'], checkpoint: false }, ownerId: OWNER, capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, paused: false, createdAt: '2026-09-01T00:00:00.000Z' };
const cloud: DriveEnvDTO = { id: 'env-cloud', driveId: 'drive-1', name: 'staging', substrate: 'sprite', status: 'running', createdAt: '2026-09-01T00:00:00.000Z' };
const mutate = vi.fn();

function feed(envs: DriveEnvDTO[]) {
  mockUseDriveEnvs.mockReturnValue({ envs, isLoading: false, error: undefined, mutate });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPatch.mockResolvedValue({});
  mockDel.mockResolvedValue({});
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ members: [{ userId: OWNER, user: { name: 'Jono', email: 'jono@example.test' } }] }) });
  feed([cloud, mac]);
});

const asOwner = () => mockUseAuth.mockReturnValue({ user: { id: OWNER } });
const asAdmin = () => mockUseAuth.mockReturnValue({ user: { id: ADMIN } });

describe('the list', () => {
  it('lists every environment with its status and, for a local one, whose machine it is and what PageSpace may ask of it; only a local row opens an editor', async () => {
    asOwner();
    render(<EnvironmentsManager driveId="drive-1" canAdminister />);
    const cloudRow = screen.getByTestId('env-row-env-cloud');
    expect(cloudRow).toHaveTextContent('staging');
    expect(cloudRow).toHaveTextContent('Running');
    expect(within(cloudRow).queryByRole('button')).toBeNull();
    const macRow = screen.getByTestId('env-row-env-mac');
    expect(macRow).toHaveTextContent('Connected');
    expect(macRow).toHaveTextContent('Your machine');
    expect(macRow).toHaveTextContent('PageSpace may: read files');
    await userEvent.setup().click(within(macRow).getByRole('button', { name: 'Open mac' }));
    expect(await screen.findByTestId('env-editor-env-mac')).toBeInTheDocument();
  });

  it('a stopped machine reads Stopped on its row', () => {
    asOwner();
    feed([{ ...mac, paused: true }]);
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} />);
    expect(screen.getByTestId('env-row-env-mac')).toHaveTextContent('Stopped');
  });
});

describe('the editor — owner', () => {
  it('shows live toggles, the effective capability from intersectCapabilities, Stop, Revoke and the activity panel; toggling PATCHes the policy and refreshes', async () => {
    asOwner();
    const user = userEvent.setup();
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    const editor = await screen.findByTestId('env-editor-env-mac');
    expect(screen.queryByTestId('env-read-only-notice')).toBeNull();
    // Owner named from the member list, not the raw id.
    await waitFor(() => expect(screen.getByTestId('env-owner-name')).toHaveTextContent('Jono'));
    // Toggles: fs_read on, others off, all enabled.
    const readFiles = within(editor).getByRole('switch', { name: 'Read files' });
    const runCommands = within(editor).getByRole('switch', { name: 'Run commands' });
    expect(readFiles).toBeChecked();
    expect(runCommands).not.toBeChecked();
    expect(runCommands).toBeEnabled();
    // Effective: machine advertises shell+fs, PageSpace allows fs_read only ⇒ read possible, write and exec not, terminal (no pty) not.
    const effective = screen.getByTestId('env-effective');
    const allowed = Object.fromEntries([...effective.querySelectorAll('li')].map((li) => [li.getAttribute('data-op'), li.getAttribute('data-allowed')]));
    expect(allowed).toEqual({ fs_read: 'true', fs_write: 'false', exec: 'false', pty_open: 'false' });
    // No bindPolicy anywhere: it is not a choice.
    expect(editor.textContent).not.toMatch(/bindPolicy|Bind policy/);
    expect(screen.getByTestId('env-stop-resume')).toHaveTextContent('Stop');
    expect(screen.getByTestId('env-revoke')).toBeInTheDocument();
    expect(screen.getByTestId('activity-panel')).toBeInTheDocument();
    expect(mockPanel).toHaveBeenCalledWith(expect.objectContaining({ driveId: 'drive-1', envId: 'env-mac', enabled: true }));
    expect(mockStartEditing).toHaveBeenCalledWith('drive-env-editor-env-mac', 'form', expect.objectContaining({ componentName: 'EnvironmentEditor' }));

    await user.click(runCommands);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-mac', { serverPolicy: { ops: ['fs_read', 'exec'], checkpoint: false } }));
    expect(mutate).toHaveBeenCalled();
  });

  it('Stop PATCHes paused: true; on a stopped machine the button reads Resume and PATCHes paused: false', async () => {
    asOwner();
    const user = userEvent.setup();
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    await user.click(await screen.findByTestId('env-stop-resume'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-mac', { paused: true }));
    feed([cloud, { ...mac, paused: true }]);
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    const resume = (await screen.findAllByTestId('env-stop-resume')).at(-1)!;
    expect(resume).toHaveTextContent('Resume');
    await user.click(resume);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-mac', { paused: false }));
  });

  it('Revoke confirms, then DELETEs the env (which revokes the machine first) and leaves the editor', async () => {
    asOwner();
    const user = userEvent.setup();
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    await user.click(await screen.findByTestId('env-revoke'));
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-mac?force=true'));
    await waitFor(() => expect(screen.queryByTestId('env-editor-env-mac')).toBeNull());
  });

  it('before the first hello, every capability reads not possible and the page says the machine has not connected', async () => {
    asOwner();
    feed([{ ...mac, capabilities: null, status: 'disconnected' }]);
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    const effective = await screen.findByTestId('env-effective');
    expect([...effective.querySelectorAll('li')].every((li) => li.getAttribute('data-allowed') === 'false')).toBe(true);
    expect(screen.getByText(/has not connected yet/)).toBeInTheDocument();
  });
});

describe('the editor — a drive admin who did not enrol the machine (D-6)', () => {
  it('sees the page read-only with a line naming the owner: toggles disabled, no Stop, no activity panel, but Revoke', async () => {
    asAdmin();
    render(<EnvironmentsManager driveId="drive-1" canAdminister initialEnvId="env-mac" />);
    const editor = await screen.findByTestId('env-editor-env-mac');
    await waitFor(() => expect(screen.getByTestId('env-read-only-notice')).toHaveTextContent('Jono'));
    expect(screen.getByTestId('env-read-only-notice')).toHaveTextContent(/owner/);
    for (const name of ['Read files', 'Write files', 'Run commands']) expect(within(editor).getByRole('switch', { name })).toBeDisabled();
    expect(screen.queryByTestId('env-stop-resume')).toBeNull();
    expect(screen.queryByTestId('activity-panel')).toBeNull();
    expect(screen.getByTestId('env-revoke')).toBeInTheDocument();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('a plain member who is not the owner and cannot administer gets read-only and NO Revoke either', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-member' } });
    render(<EnvironmentsManager driveId="drive-1" canAdminister={false} initialEnvId="env-mac" />);
    await screen.findByTestId('env-editor-env-mac');
    expect(screen.getByTestId('env-read-only-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('env-revoke')).toBeNull();
    expect(screen.queryByTestId('env-stop-resume')).toBeNull();
  });
});

describe('ownerDisplayName', () => {
  it('prefers the member name, then email, then the id; an erased owner is said so', () => {
    expect(ownerDisplayName('u1', [{ userId: 'u1', user: { name: 'Ada', email: 'a@x' } }])).toBe('Ada');
    expect(ownerDisplayName('u1', [{ userId: 'u1', user: { name: null, email: 'a@x' } }])).toBe('a@x');
    expect(ownerDisplayName('u1', [])).toBe('u1');
    expect(ownerDisplayName('u1', undefined)).toBe('u1');
    expect(ownerDisplayName(null, [])).toBe('an erased account');
  });
});
