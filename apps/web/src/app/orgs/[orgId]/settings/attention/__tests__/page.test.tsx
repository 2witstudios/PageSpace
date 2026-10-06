import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'MEMBER',
  notice: undefined as undefined | Record<string, unknown>,
  reads: {} as Record<string, unknown>,
  decideGuestApproval: vi.fn(),
  reassignAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({ org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'n', avatarUrl: null, ownerId: 'u', createdAt: '' }, viewer: { userId: 'u', role: mocks.role }, billingNotice: mocks.notice }, isLoading: false, mutate: vi.fn() }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string) => ({ data: mocks.reads[key] }),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  decideGuestApproval: mocks.decideGuestApproval,
  reassignAutomation: mocks.reassignAutomation,
  deleteAutomation: mocks.deleteAutomation,
}));

import OrgAttentionPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.notice = undefined;
  mocks.reads = {
    '/api/orgs/org_nw/guest-approvals': { total: 1, items: [{ holdId: 'h1', driveId: 'd_mkt', userId: 'u_nadia', email: 'nadia@fox.example', origin: 'drive_link', createdAt: '', driveName: 'Marketing Site', requesterName: 'Nadia Fox', request: { role: 'GUEST', customRoleId: null, pageGrants: 2, tokenScopes: 0, earliestExpiry: '2026-10-19T00:00:00Z', viaLink: true } }] },
    '/api/orgs/org_nw/automations': { automations: [{ kind: 'workflow', id: 'wf_1', driveId: 'd_cr', name: 'Lead scoring', ownerLeftAt: '2026-10-01T00:00:00Z' }] },
    '/api/orgs/org_nw/members': { members: [{ userId: 'u_lena', role: 'MEMBER', name: 'Lena Schulz', email: 'lena@n.com', image: null, joinedAt: '' }] },
    '/api/orgs/org_nw/policies': { policies: { guests: 'approve' } },
    '/api/orgs/org_nw/drives': { drives: [{ id: 'd_cr', name: 'Customer Research', slug: 'cr', orgVisibility: 'RESTRICTED', lead: { id: 'u', name: 'L', image: null }, joined: true, joinRequest: null, canRequest: false }] },
  };
  mocks.decideGuestApproval.mockResolvedValue({ decided: 'approved' });
  mocks.reassignAutomation.mockResolvedValue({ reassigned: true });
  mocks.deleteAutomation.mockResolvedValue({ deleted: true });
});

describe('Needs your attention', () => {
  it('POL-2 (partial): a guest request shows exactly the access it would grant, under the Guests policy', () => {
    render(<OrgAttentionPage />);
    expect(screen.getByText('Guest approvals · 1 waiting')).toBeTruthy();
    expect(screen.getByText('Nadia Fox')).toBeTruthy();
    expect(screen.getByText('via link')).toBeTruthy();
    expect(screen.getByText('Pages: 2 pages')).toBeTruthy();
    expect(screen.getByText('Expires: Oct 19')).toBeTruthy();
    expect(screen.getByText('Admins approve')).toBeTruthy();
  });

  it('POL-2 (partial): approve and decline decide the hold', async () => {
    render(<OrgAttentionPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.decideGuestApproval).toHaveBeenCalledWith('org_nw', 'h1', 'approve'));
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mocks.decideGuestApproval).toHaveBeenCalledWith('org_nw', 'h1', 'decline'));
  });

  it('SEAT-9 (partial) D-OW-33: approving is disabled while lapsed; declining still works', async () => {
    mocks.notice = { kind: 'reactivate', reason: 'canceled', canManageBilling: true };
    render(<OrgAttentionPage />);
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Reactivate the organization to approve guests.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mocks.decideGuestApproval).toHaveBeenCalledWith('org_nw', 'h1', 'decline'));
  });

  it('SPEND-6 (partial): an owner-left automation is reassigned to a member, or deleted', async () => {
    render(<OrgAttentionPage />);
    expect(screen.getByText('Lead scoring')).toBeTruthy();
    expect(screen.getByText('Owner left')).toBeTruthy();
    expect(screen.getByText('Customer Research')).toBeTruthy();
    expect(screen.getByText(/spends the drive’s wallet only, under its new owner’s caps/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reassign' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('combobox', { name: 'New owner for Lead scoring' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Lena Schulz' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(mocks.reassignAutomation).toHaveBeenCalledWith('org_nw', expect.objectContaining({ kind: 'workflow', id: 'wf_1' }), 'u_lena'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deleteAutomation).toHaveBeenCalledWith('org_nw', expect.objectContaining({ id: 'wf_1' })));
  });

  it('a refused approval shows its copy', async () => {
    mocks.decideGuestApproval.mockRejectedValue(new ApiRequestError('raw', 409, { error: 'raw', code: 'link_gone' }));
    render(<OrgAttentionPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('The share link for this request no longer exists.'));
  });

  it('UI-11 (partial): a plain Member sees none of it', () => {
    mocks.role = 'MEMBER';
    render(<OrgAttentionPage />);
    expect(screen.queryByText('Nadia Fox')).toBeNull();
  });
});
