import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDriveDirectoryEntry } from '@/lib/orgs/org-api';

const mocks = vi.hoisted(() => ({
  role: 'MEMBER' as 'OWNER' | 'ADMIN' | 'MEMBER',
  drives: [] as OrgDriveDirectoryEntry[],
  mutate: vi.fn(),
  requestToJoinDrive: vi.fn(),
  useOrgRealtime: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({ org: { organization: { id: 'org_nw', name: 'Northwind Labs' }, viewer: { userId: 'u_me', role: mocks.role } }, isLoading: false }),
  useOrgDriveDirectory: () => ({ data: { drives: mocks.drives }, mutate: mocks.mutate }),
  useOrgRealtime: mocks.useOrgRealtime,
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  requestToJoinDrive: mocks.requestToJoinDrive,
}));

import OrgDrivesDirectoryPage from '../page';

const lead = { id: 'u_lead', name: 'Priya', image: null };
const drive = (id: string, name: string, over: Partial<OrgDriveDirectoryEntry>): OrgDriveDirectoryEntry => ({
  id, name, slug: id, orgVisibility: 'OPEN', lead, joined: true, joinRequest: null, canRequest: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'MEMBER';
  mocks.requestToJoinDrive.mockResolvedValue({ request: { id: 'jr_1' } });
  mocks.drives = [
    drive('d_open', 'Handbook', { orgVisibility: 'OPEN' }),
    drive('d_joined', 'Roadmap', { orgVisibility: 'RESTRICTED' }),
    drive('d_private', 'Payroll', { orgVisibility: 'PRIVATE' }),
    drive('d_ask', 'Finance', { orgVisibility: 'RESTRICTED', joined: false, canRequest: true }),
    drive('d_pending', 'Legal', { orgVisibility: 'RESTRICTED', joined: false, joinRequest: 'pending' }),
  ];
});

const section = (name: string) => screen.getByRole('region', { name });

describe('the org Drives directory for a plain Member (DRV-6, D-OW-25)', () => {
  it('DRV-6 (partial) a Member sees Open drives, drives they joined and Private drives they are on to open, and Restricted drives to ask to join', () => {
    render(<OrgDrivesDirectoryPage />);
    const mine = section('Your drives');
    for (const name of ['Handbook', 'Roadmap', 'Payroll']) {
      expect(within(mine).getByText(name)).toBeTruthy();
    }
    expect(within(mine).getAllByRole('link', { name: 'Open' }).map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/d_open', '/dashboard/d_joined', '/dashboard/d_private',
    ]);
    const ask = section('Ask to join');
    expect(within(ask).getByText('Finance')).toBeTruthy();
    expect(within(ask).getByRole('button', { name: 'Ask to join' })).toBeTruthy();
    expect(within(ask).getByText('Requested')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Private drives' })).toBeNull();
    // Live: the directory follows org:changed for this org.
    expect(mocks.useOrgRealtime).toHaveBeenCalledWith('org_nw');
  });

  it('DRV-6 (partial) asking to join sends the request with the note, then the directory refreshes to Requested', async () => {
    render(<OrgDrivesDirectoryPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Quarter close');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(mocks.requestToJoinDrive).toHaveBeenCalledWith('d_ask', 'Quarter close'));
    expect(mocks.mutate).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Request sent to Priya');
  });

  it('an org admin also sees the Private drives they are not on, to manage', () => {
    mocks.role = 'ADMIN';
    mocks.drives = [drive('d_secret', 'Board', { orgVisibility: 'PRIVATE', joined: false })];
    render(<OrgDrivesDirectoryPage />);
    expect(within(section('Private drives')).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/dashboard/d_secret/settings');
  });

  it('says so when there is nothing to see', () => {
    mocks.drives = [];
    render(<OrgDrivesDirectoryPage />);
    expect(screen.getByText('Northwind Labs has no drives you can see yet.')).toBeTruthy();
  });
});
