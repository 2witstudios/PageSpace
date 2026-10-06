import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({ useParams: () => ({ driveId: 'd-product' }), useRouter: () => ({ push: vi.fn() }) }));
const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
const mockPost = vi.fn();
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ApiRequestError: (await importOriginal<typeof import('@/lib/auth/auth-fetch')>()).ApiRequestError,
  post: (...a: unknown[]) => mockPost(...a),
  fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a),
}));
vi.mock('@/components/members/PermissionsGrid', () => ({ PermissionsGrid: () => <div /> }));
vi.mock('@/hooks/useDebounce', () => ({ useDebounce: <T,>(v: T) => v }));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null) => (id ? { id, name: 'Northwind Labs' } : null) }) }));

import InviteMemberPage from '../page';
import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { useDriveStore } from '@/hooks/useDrive';

const okJson = (d: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(d) });
const serve = (guests: 'on' | 'approve' | 'off' | 'unreadable') =>
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.includes('/roles')) return okJson({ roles: [] });
    if (url.endsWith('/api/orgs/o-northwind/members')) return okJson({ members: [{ userId: 'u-priya', email: 'priya@northwind.com' }] });
    // An inviter who is not an org Owner or Admin cannot read the policies.
    if (url.endsWith('/api/orgs/o-northwind/policies')) return guests === 'unreadable' ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ code: 'insufficient_role' }) }) : okJson({ policies: { guests } });
    return okJson({ users: [] });
  });

const typeEmail = async (email: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText(/search by username/i), email);
  await user.click(await screen.findByRole('button', { name: new RegExp(`invite ${email}`, 'i') }));
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  useDriveStore.setState({ drives: [{ id: 'd-product', name: 'Product', slug: 'p', ownerId: 'u-priya', isTrashed: false, trashedAt: null, createdAt: '', updatedAt: '', isOwned: true, orgId: 'o-northwind' }], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
});

describe('Invite to an org drive', () => {
  it('UI-5 (partial) an outsider is offered guest or member; as a member it sends an ORG invitation (a seat), not a drive invite', async () => {
    serve('on');
    mockPost.mockResolvedValue({ invitation: { id: 'inv-1' } });
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    const user = await typeEmail('chris@partner.co');
    expect(await screen.findByTestId('invite-join-choice')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /As a member of Northwind Labs/ }));
    await user.click(screen.getByRole('button', { name: 'Invite to Northwind Labs' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/orgs/o-northwind/invitations', { email: 'chris@partner.co', role: 'MEMBER' }));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('UI-5 (partial) POL-2 (partial) as a guest it is the drive invite, and an approve policy is reported as waiting for an admin, not as success', async () => {
    serve('approve');
    mockPost.mockResolvedValue({ kind: 'pending_approval', holdId: 'h1' });
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    const user = await typeEmail('chris@partner.co');
    expect((await screen.findByRole('radio', { name: /As a guest of this drive/ })).getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByText(/Needs approval from a Northwind Labs admin/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /invite member/i }));
    await waitFor(() => expect(mockPost.mock.calls[0][0]).toBe('/api/drives/d-product/members/invite'));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent to the Northwind Labs Owner and Admins for approval. Nothing is shared until they approve.'));
  });

  it('UI-5 (partial) with guests off, the guest choice is unavailable and member is preselected', async () => {
    serve('off');
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    await typeEmail('chris@partner.co');
    await waitFor(() => expect(screen.getByRole('radio', { name: /As a guest of this drive/ }).hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('radio', { name: /As a member of Northwind Labs/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('UI-5 (partial) POL-2 (partial) an inviter who cannot read the Guests policy is told it may need approval or be off; a guests refusal names the policy and turns the guest choice off', async () => {
    serve('unreadable');
    mockPost.mockRejectedValue(new ApiRequestError('raw', 403, { error: 'raw', code: 'org_policy', policy: 'guests' }));
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    const user = await typeEmail('chris@partner.co');
    expect(await screen.findByText(/Depends on the Northwind Labs Guests policy/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /invite member/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Guests are turned off for Northwind Labs, so they cannot join as a guest. Give them a seat instead.'));
    expect(mocks.toastError).not.toHaveBeenCalledWith('An organization policy does not allow this.');
    await waitFor(() => expect(screen.getByRole('radio', { name: /As a guest of this drive/ }).hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('radio', { name: /As a member of Northwind Labs/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('UI-5 (partial) someone already in the org gets no choice: a plain drive invite', async () => {
    serve('on');
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    await typeEmail('priya@northwind.com');
    await waitFor(() => expect(screen.queryByTestId('invite-join-choice')).toBeNull());
  });
});
