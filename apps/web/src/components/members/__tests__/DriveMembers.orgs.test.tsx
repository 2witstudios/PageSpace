import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, del, post: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => null }));
// [D-OW-33] each test says whether Northwind is lapsed.
const orgLapsed = vi.hoisted(() => ({ current: false }));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null) => (id ? { id, name: 'Northwind Labs', lapsed: orgLapsed.current } : null) }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const shareLinkSection = vi.hoisted(() => vi.fn((_props: { driveId: string; lapsed?: boolean }) => null));
vi.mock('../DriveShareLinkSection', () => ({ DriveShareLinkSection: shareLinkSection }));

import { DriveMembers } from '../DriveMembers';
import { useDriveStore } from '@/hooks/useDrive';

const person = (userId: string, name: string, extra: Record<string, unknown>) => ({
  id: `dm-${userId}`, userId, role: 'MEMBER', invitedAt: '2026-05-01T00:00:00Z', acceptedAt: '2026-05-02T00:00:00Z',
  user: { id: userId, email: `${userId}@x.test`, name }, profile: { displayName: name }, customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 }, ...extra,
});

const respond = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const membersBody = (role: 'OWNER' | 'MEMBER', guests: unknown[]) => ({
  currentUserRole: role,
  pendingInvites: [],
  guests,
  members: [
    person('u-priya', 'Priya Nair', { role: 'OWNER', source: 'lead', isGuest: false }),
    person('u-lena', 'Lena Schulz', { source: 'org', isGuest: false }),
    person('u-chris', 'Chris Rowe', { source: 'invite', isGuest: true }),
  ],
});
const nadia = { userId: 'u-nadia', displayName: 'Nadia Fox', username: null, avatarUrl: null, acceptedAt: null, source: 'invite', pageGrantCount: 1, pages: [{ pageId: 'p-launch', title: 'Launch plan', role: 'view', expiresAt: '2026-10-19T00:00:00Z' }] };

const serve = (body: unknown) => fetchWithAuth.mockImplementation((url: string) => {
  if (url.endsWith('/agents/members')) return respond({ agentMembers: [] });
  if (url.endsWith('/apps/members')) return respond({ appMembers: [] });
  if (url.endsWith('/roles')) return respond({ roles: [] });
  return respond(body);
});

beforeEach(() => {
  vi.clearAllMocks();
  orgLapsed.current = false;
  useDriveStore.setState({ drives: [{ id: 'd-product', name: 'Product', slug: 'p', ownerId: 'u-priya', isTrashed: false, trashedAt: null, createdAt: '', updatedAt: '', isOwned: true, orgId: 'o-northwind' }], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
});

describe('DriveMembers on an org drive', () => {
  it('UI-5 (partial) DRV-8 (partial) each member shows where its access comes from, and the outsider is labeled Guest', async () => {
    serve(membersBody('OWNER', []));
    render(<DriveMembers driveId="d-product" />);
    await waitFor(() => expect(screen.getByText('Chris Rowe')).toBeTruthy());
    const row = (name: string) => screen.getByText(name).closest('.p-4') as HTMLElement;
    expect(within(row('Priya Nair')).getByText('Lead')).toBeTruthy();
    expect(within(row('Lena Schulz')).getByText('Org')).toBeTruthy();
    expect(within(row('Lena Schulz')).queryByText('Guest')).toBeNull();
    expect(within(row('Chris Rowe')).getByText('Guest')).toBeTruthy();
    expect(within(row('Chris Rowe')).getByText('Invite')).toBeTruthy();
    expect(screen.getByTestId('member-source-legend')).toBeTruthy();
  });

  it('UI-5 (partial) the lead sees page-link guests by page, role and expiry, and can revoke one page', async () => {
    serve(membersBody('OWNER', [nadia]));
    render(<DriveMembers driveId="d-product" />);
    const section = await screen.findByTestId('page-link-guests');
    expect(section.textContent).toContain('Nadia Fox');
    expect(section.textContent).toContain('Launch plan');
    expect(section.textContent).toContain('View');
    fireEvent.click(within(section).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/pages/p-launch/permissions', { userId: 'u-nadia' }));
  });

  it('UI-5 (partial) a plain member gets no page-link guest list (the route answers [] for them)', async () => {
    serve(membersBody('MEMBER', []));
    render(<DriveMembers driveId="d-product" />);
    await waitFor(() => expect(screen.getByText('Chris Rowe')).toBeTruthy());
    expect(screen.queryByTestId('page-link-guests')).toBeNull();
  });

  it('SEAT-9 (partial) [D-OW-33] while the org is lapsed, inviting a member, inviting an agent and new invite links are disabled with the restrict-only note; paid, they are enabled', async () => {
    orgLapsed.current = true;
    serve(membersBody('OWNER', []));
    const { unmount } = render(<DriveMembers driveId="d-product" />);
    await waitFor(() => expect(screen.getByText('Chris Rowe')).toBeTruthy());
    expect((screen.getByRole('button', { name: /Invite Member/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Invite Agent/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('lapsed-loosen-note').textContent).toContain('Removing access and lowering roles still work');
    expect(shareLinkSection.mock.calls.at(-1)?.[0]).toMatchObject({ driveId: 'd-product', lapsed: true });
    unmount();

    orgLapsed.current = false;
    render(<DriveMembers driveId="d-product" />);
    await waitFor(() => expect(screen.getByText('Chris Rowe')).toBeTruthy());
    expect((screen.getByRole('button', { name: /Invite Member/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('lapsed-loosen-note')).toBeNull();
    expect(shareLinkSection.mock.calls.at(-1)?.[0]).toMatchObject({ lapsed: false });
  });
});
