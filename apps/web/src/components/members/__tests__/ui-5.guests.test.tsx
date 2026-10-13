/**
 * UI-5 in one place: on an org drive the Members page labels the outsider Guest, and inviting an
 * outsider offers guest (a drive invite) or member (an org invitation, a seat).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';

vi.mock('next/navigation', () => ({ useParams: () => ({ driveId: 'd-product' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const api = vi.hoisted(() => ({
  fetchWithAuth: vi.fn<(url: string) => Promise<unknown>>(),
  post: vi.fn<(url: string, body?: unknown) => Promise<unknown>>(),
  del: vi.fn<(url: string, body?: unknown) => Promise<unknown>>(async () => ({})),
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ApiRequestError: (await importOriginal<typeof import('@/lib/auth/auth-fetch')>()).ApiRequestError,
  fetchWithAuth: (url: string) => api.fetchWithAuth(url),
  post: (url: string, body?: unknown) => api.post(url, body),
  del: (url: string, body?: unknown) => api.del(url, body),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
vi.mock('@/hooks/useDebounce', () => ({ useDebounce: <T,>(v: T) => v }));
vi.mock('@/components/members/PermissionsGrid', () => ({ PermissionsGrid: () => <div /> }));
vi.mock('../DriveShareLinkSection', () => ({ DriveShareLinkSection: () => null }));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null) => (id ? { id, name: 'Northwind Labs', lapsed: false } : null) }) }));

import { DriveMembers } from '../DriveMembers';
import InviteMemberPage from '@/app/dashboard/[driveId]/members/invite/page';
import { useDriveStore } from '@/hooks/useDrive';

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const person = (userId: string, name: string, extra: Record<string, unknown>) => ({
  id: `dm-${userId}`, userId, role: 'MEMBER', invitedAt: '2026-05-01T00:00:00Z', acceptedAt: '2026-05-02T00:00:00Z',
  user: { id: userId, email: `${userId}@x.test`, name }, profile: { displayName: name }, customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  useDriveStore.setState({ drives: [{ id: 'd-product', name: 'Product', slug: 'p', ownerId: 'u-priya', isTrashed: false, trashedAt: null, createdAt: '', updatedAt: '', isOwned: true, orgId: 'o-northwind' }], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
  api.fetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith('/agents/members')) return ok({ agentMembers: [] });
    if (url.endsWith('/apps/members')) return ok({ appMembers: [] });
    if (url.includes('/roles')) return ok({ roles: [] });
    if (url.endsWith('/api/drives/d-product/members')) {
      return ok({
        currentUserRole: 'OWNER', pendingInvites: [], guests: [],
        members: [
          person('u-priya', 'Priya Nair', { role: 'OWNER', source: 'lead', isGuest: false }),
          person('u-lena', 'Lena Schulz', { source: 'org', isGuest: false }),
          person('u-chris', 'Chris Rowe', { source: 'invite', isGuest: true }),
        ],
      });
    }
    if (url.endsWith('/api/orgs/o-northwind/members')) return ok({ members: [{ userId: 'u-priya', email: 'priya@northwind.com' }] });
    if (url.endsWith('/api/orgs/o-northwind/policies')) return ok({ policies: { guests: 'on' } });
    return ok({ users: [] });
  });
});

describe('guests on an org drive', () => {
  it('UI-5 the Members page labels the outsider Guest, and inviting an outsider offers guest (drive invite) or member (org invitation, a seat)', async () => {
    const members = render(<DriveMembers driveId="d-product" />);
    await waitFor(() => expect(screen.getByText('Chris Rowe')).toBeTruthy());
    const row = (name: string) => screen.getByText(name).closest('.p-4') as HTMLElement;
    expect(within(row('Chris Rowe')).getByText('Guest')).toBeTruthy();
    expect(within(row('Lena Schulz')).queryByText('Guest')).toBeNull();
    members.unmount();

    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><InviteMemberPage /></SWRConfig>);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/search by username/i), 'sam@partner.co');
    await user.click(await screen.findByRole('button', { name: /invite sam@partner.co/i }));
    const choice = await screen.findByTestId('invite-join-choice');
    expect(within(choice).getByRole('radio', { name: /As a member of Northwind Labs/ })).toBeTruthy();
    expect(within(choice).getByRole('radio', { name: /guest/i })).toBeTruthy();
    api.post.mockResolvedValue({ invitation: { id: 'inv-1' } });
    await user.click(screen.getByRole('radio', { name: /As a member of Northwind Labs/ }));
    await user.click(screen.getByRole('button', { name: 'Invite to Northwind Labs' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/orgs/o-northwind/invitations', { email: 'sam@partner.co', role: 'MEMBER' }));
  });
});
