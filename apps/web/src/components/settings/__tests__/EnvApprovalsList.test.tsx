/**
 * `EnvApprovalsList` (GA wave 3, leaf 5): the revocable list in the
 * ConnectedAppsList shape. Revoke rides the drive route's DELETE and reports
 * only what the MACHINE said — a 202 or a no-socket 409 is "recorded, will be
 * delivered on reconnect", never "revoked".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockDel = vi.fn();
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth-fetch')>();
  return { ...actual, del: (...args: unknown[]) => mockDel(...args) };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { EnvApprovalsList, describeRevokeAnswer } from '../EnvApprovalsList';
import type { DriveEnvApprovalDTO } from '@pagespace/lib/drive-envs/env-contract';

const row = (over: Partial<DriveEnvApprovalDTO> = {}): DriveEnvApprovalDTO => ({ id: 'ch_1', envId: 'env-1', driveId: 'drive-1', envName: 'mac', envLabel: 'jono-macstudio', userId: 'u', op: 'exec', summary: "exec: sh -c 'git status'", scope: '30d', createdAt: '2026-09-09T12:00:00.000Z', expiresAt: '2026-10-09T12:00:00.000Z', revokedAt: null, revokeAcknowledgedAt: null, revokePending: false, ...over });
const refetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockDel.mockResolvedValue({ revoked: true, machine: 'acknowledged', approvalId: 'ch_1', removed: 2 });
});

describe('describeRevokeAnswer — honest words for each answer', () => {
  it.each([
    [200, { removed: 2 }, 'Approval revoked', true],
    [202, { reason: 'unacknowledged' }, 'Revoke sent, not yet confirmed', false],
    [409, { reason: 'no_live_socket' }, 'Machine not connected', false],
    [409, { reason: 'revoked' }, 'Could not revoke the approval', false],
    [500, null, 'Could not revoke the approval', false],
  ] as const)('%i %o', (status, body, title, gone) => {
    expect(describeRevokeAnswer(status, body)).toMatchObject({ title, gone });
  });
});

describe('EnvApprovalsList', () => {
  it('lists each approval with its command, scope, expiry and a link to the machine\'s drive settings page', () => {
    render(<EnvApprovalsList approvals={[row()]} isLoading={false} isError={false} refetch={refetch} />);
    const item = screen.getByTestId('env-approval-ch_1');
    expect(item).toHaveTextContent("exec: sh -c 'git status'");
    expect(item).toHaveTextContent('for 30 days');
    expect(screen.getByRole('link', { name: 'jono-macstudio' })).toHaveAttribute('href', '/dashboard/drive-1/settings/environments?env=env-1');
  });

  it('flags a revoke the machine has not confirmed yet', () => {
    render(<EnvApprovalsList approvals={[row({ revokedAt: '2026-09-09T12:01:00.000Z', revokePending: true })]} isLoading={false} isError={false} refetch={refetch} />);
    expect(screen.getByTestId('env-approval-ch_1')).toHaveTextContent('revoke pending');
  });

  it('empty and error states say so; the empty state reminds that every command still needs a click', () => {
    const { rerender } = render(<EnvApprovalsList approvals={[]} isLoading={false} isError={false} refetch={refetch} />);
    expect(screen.getByTestId('env-approvals-empty')).toHaveTextContent('still needs your click');
    rerender(<EnvApprovalsList approvals={[]} isLoading={false} isError refetch={refetch} />);
    expect(screen.getByText(/Failed to load approvals/)).toBeInTheDocument();
  });

  it('Revoke confirms, DELETEs through the drive route with the row\'s own drive and env, reports the machine\'s ack, and refetches', async () => {
    const user = userEvent.setup();
    render(<EnvApprovalsList approvals={[row()]} isLoading={false} isError={false} refetch={refetch} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke' , hidden: false }).then(() => screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!));
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/drives/drive-1/envs/env-1/approvals/ch_1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Approval revoked', expect.objectContaining({ description: expect.stringContaining('2 approval rows') })));
    expect(refetch).toHaveBeenCalled();
  });

  it('a 202 (unacknowledged) or a no-socket 409 is reported as recorded-and-replayed, not as revoked; any other failure is an error', async () => {
    const user = userEvent.setup();
    mockDel.mockRejectedValueOnce(new ApiRequestError('sent', 202, { revoked: false, reason: 'unacknowledged' }));
    render(<EnvApprovalsList approvals={[row()]} isLoading={false} isError={false} refetch={refetch} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    await waitFor(() => expect(toast.message).toHaveBeenCalledWith('Revoke sent, not yet confirmed', expect.anything()));
    expect(toast.success).not.toHaveBeenCalled();
    mockDel.mockRejectedValueOnce(new ApiRequestError('nope', 500, { error: 'boom' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not revoke the approval', expect.anything()));
  });

  it('an env-scoped list (no driveId on the row) uses the driveId prop for the route', async () => {
    const user = userEvent.setup();
    render(<EnvApprovalsList approvals={[row({ driveId: null, envName: null, envLabel: null })]} isLoading={false} isError={false} refetch={refetch} driveId="drive-9" />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1)!);
    await waitFor(() => expect(mockDel).toHaveBeenCalledWith('/api/drives/drive-9/envs/env-1/approvals/ch_1'));
  });
});
